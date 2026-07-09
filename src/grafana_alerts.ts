/**
 * Module: grafana_alerts
 * Receives Grafana webhook POSTs and forwards alerts to Matrix rooms.
 *
 * Enable by setting GRAFANA_ALERTS_PORT in .env.
 * Users can silence individual alerts by replying "silence 2h" or 🔕 to an
 * alert message; this creates a real Grafana silence via the API.
 * Use !alerts mute / !alerts unmute to pause all forwarding.
 */

import * as http from "http";
import * as crypto from "crypto";
import axios from "axios";
import { MsgType } from "matrix-js-sdk";
import { BotModule, ModuleRegistry, renderHtml } from "lumi";
import { BotConfig, env, envInt, envList, envBool } from "lumi";
import { ModuleStore } from "lumi";
import { logger } from "lumi";
import { renderAndUpload } from "./lib/grafana_render";

const log = logger.getLogger("grafana_alerts");

// ── Types ─────────────────────────────────────────────────────────────────────

interface GrafanaAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  fingerprint: string;
  dashboardURL?: string;
  panelURL?: string;
  silenceURL?: string;
}

interface GrafanaPayload {
  alerts: GrafanaAlert[];
}

interface AlertRecord {
  alertname: string;
  labels: Record<string, string>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse "30m", "2h", "1d" → milliseconds. Returns null on bad input. */
function parseDuration(s: string): number | null {
  const m = s.match(/^(\d+)(m|h|d)$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  switch (m[2]!.toLowerCase()) {
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default:  return null;
  }
}

/** Format milliseconds back to a human label (must be a round unit). */
function formatDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000  === 0) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

/**
 * Convert a Grafana UI panelURL to a renderer URL.
 * Input:  https://grafana.example.com/d/{uid}/{slug}?viewPanel=5  (slug is optional)
 * Output: {grafanaUrl}/render/d-solo/{uid}/{slug}?panelId=5&width=1000&height=500&from=now-30m&to=now
 */
function panelUrlToRenderUrl(
  panelUrl: string,
  grafanaUrl: string,
  status: "firing" | "resolved" = "firing",
): string | null {
  try {
    const u = new URL(panelUrl);
    const match = u.pathname.match(/^\/d\/([^/]+)(?:\/([^/]+))?/);
    if (!match) return null;
    const uid = match[1]!;
    const slug = match[2];
    const panelId = u.searchParams.get("viewPanel");
    if (!panelId) return null;
    const path = slug ? `${uid}/${slug}` : uid;
    const from = status === "resolved" ? "now-6h" : "now-1h";
    return `${grafanaUrl.replace(/\/$/, "")}/render/d-solo/${path}?panelId=${panelId}&width=1000&height=500&from=${from}&to=now&theme=dark&scale=2`;
  } catch {
    return null;
  }
}

/** Build the Matrix message text for an alert. */
function formatAlert(alert: GrafanaAlert): string {
  const name = alert.labels.alertname ?? "Unknown";
  const icon = alert.status === "firing" ? "🔥" : "✅";
  const statusLabel = alert.status === "firing" ? "FIRING" : "RESOLVED";
  const lines = [`${icon} **[${statusLabel}] ${name}**`];

  if (alert.status === "firing") {
    const severity = alert.labels.severity;
    if (severity) lines.push(`severity: ${severity}`);
    const summary = alert.annotations.summary;
    if (summary) lines.push(summary);
    const description = alert.annotations.description;
    if (description && description !== summary) lines.push(description);
    lines.push(`Reply \`silence 2h\` or 🔕 to silence this alert.`);
  }

  return lines.join("\n");
}

/**
 * Verify Grafana HMAC-SHA256 signature.
 * If a timestamp is provided Grafana signs `timestamp:body`, otherwise just `body`.
 * The timestamp header name is user-configurable in Grafana so its presence is optional.
 */
function verifyHmac(
  secret: string,
  body: string,
  signature: string,
  timestamp?: string,
): boolean {
  const message = timestamp ? `${timestamp}:${body}` : body;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, "utf8"),
      Buffer.from(expected, "utf8"),
    );
  } catch {
    return false;
  }
}

// ── Module ────────────────────────────────────────────────────────────────────

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    const port             = envInt("GRAFANA_ALERTS_PORT", 0);
    const rooms            = envList("GRAFANA_ALERTS_ROOMS");
    const secret           = env("GRAFANA_ALERTS_SECRET");
    const forwardResolved  = envBool("GRAFANA_ALERTS_RESOLVED", true);
    const receiverName     = env("GRAFANA_ALERTS_RECEIVER");
    const testPanelUrl     = env("GRAFANA_TEST_PANEL_URL");

    registry.registerModule("grafana_alerts", "Forward Grafana alerts to Matrix rooms");

    if (!port) {
      log.info("GRAFANA_ALERTS_PORT not set — module disabled");
      return;
    }
    if (!rooms.length) {
      log.warn("GRAFANA_ALERTS_PORT set but GRAFANA_ALERTS_ROOMS is empty — module disabled");
      return;
    }

    const store = new ModuleStore("grafana_alerts");
    let muted = store.get<boolean>("muted", false);

    // event_id → alert record (in-memory; used for reply-to-silence)
    const alertEventMap = new Map<string, AlertRecord>();

    let firingCount   = 0;
    let resolvedCount = 0;

    // ── !alerts command ────────────────────────────────────────────────────────

    registry.register({
      name: "alerts",
      module: "grafana_alerts",
      help: "Grafana alert forwarding status and controls",
      usage: "status|mute|unmute|test",
      description:
        "`!alerts status` shows the webhook receiver state. " +
        "`!alerts mute` stops forwarding alerts to Matrix. " +
        "`!alerts unmute` resumes forwarding. " +
        "`!alerts test` fires a synthetic alert through Grafana Alertmanager to verify the full pipeline.",
      handler: async (ctx) => {
        const sub = ctx.args[0]?.toLowerCase();

        if (sub === "mute") {
          if (muted) return "🔕 Alert forwarding is already muted.";
          muted = true;
          store.set("muted", true);
          return "🔕 Alert forwarding muted. Use `!alerts unmute` to resume.";
        }

        if (sub === "unmute") {
          if (!muted) return "ℹ️ Alerts are not muted.";
          muted = false;
          store.set("muted", false);
          return "🔔 Alert forwarding resumed.";
        }

        if (sub === "test") {
          if (!config.grafanaUrl || !config.grafanaToken) {
            return "❌ `GRAFANA_URL` and `GRAFANA_TOKEN` must be configured to fire a test alert.";
          }
          if (!receiverName) {
            return "❌ `GRAFANA_ALERTS_RECEIVER` must be set to the Grafana contact point name (Alerting → Contact points).";
          }

          const base    = config.grafanaUrl.replace(/\/$/, "");
          const headers = {
            Authorization:  `Bearer ${config.grafanaToken}`,
            "Content-Type": "application/json",
          };

          try {
            // 1. Fetch contact points via provisioning API (returns full config
            //    with settings + secureFields, unlike the alertmanager status endpoint)
            type ContactPoint = {
              uid: string;
              name: string;
              type: string;
              disableResolveMessage: boolean;
              settings?: Record<string, unknown>;
              secureFields?: Record<string, boolean>;
            };
            const { data: contactPoints } = await axios.get<ContactPoint[]>(
              `${base}/api/v1/provisioning/contact-points`,
              { headers, timeout: 10_000 },
            );
            const matching = contactPoints.filter((cp) => cp.name === receiverName);
            if (!matching.length) {
              return `❌ Contact point \`${receiverName}\` not found. Check \`GRAFANA_ALERTS_RECEIVER\`.`;
            }

            // 2. Build payload in the format the Grafana UI uses for its Test button
            const testPayload = {
              receivers: [{
                name: receiverName,
                grafana_managed_receiver_configs: matching.map((cp) => ({
                  uid:                  cp.uid,
                  name:                 cp.name,
                  type:                 cp.type,
                  version:              "v1",
                  disableResolveMessage: cp.disableResolveMessage,
                  settings:             cp.settings ?? {},
                  secureFields:         cp.secureFields ?? {},
                })),
              }],
            };
            await axios.post(
              `${base}/api/alertmanager/grafana/config/api/v1/receivers/test`,
              testPayload,
              { headers, timeout: 15_000 },
            );

            // Grafana's test webhook uses a fake panelURL — render the configured
            // test panel directly instead. Delay slightly so the webhook alert
            // message arrives in the room before the image.
            if (testPanelUrl) {
              const renderUrl = panelUrlToRenderUrl(testPanelUrl, config.grafanaUrl);
              if (renderUrl) {
                void (async () => {
                  await new Promise((r) => setTimeout(r, 1_500));
                  for (const roomId of rooms) {
                    try {
                      await renderAndUpload(ctx.client, roomId, renderUrl, config.grafanaToken);
                    } catch (err) {
                      log.warn("test panel render failed:", err instanceof Error ? err.message : err);
                    }
                  }
                })();
              }
            }

            return "🔥 Test notification sent through Grafana. It should appear in this room shortly.";
          } catch (err) {
            if (axios.isAxiosError(err) && err.response) {
              const body = typeof err.response.data === "string"
                ? err.response.data
                : JSON.stringify(err.response.data);
              return `❌ Grafana returned ${err.response.status}: ${body}`;
            }
            return `❌ Could not fire test alert: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // default: status
        return [
          "**Grafana Alerts status**",
          `• Port: ${port}`,
          `• Rooms: ${rooms.length}`,
          `• Secret: ${secret ? "configured" : "not set"}`,
          `• Muted: ${muted ? "yes" : "no"}`,
          `• Forwarded: ${firingCount} firing, ${resolvedCount} resolved`,
        ].join("\n");
      },
    });

    // ── Reply handler: silence by replying to an alert message ─────────────────

    registry.registerReply({
      name: "grafana_alerts:silence",
      match: (_roomId, body) => {
        const b = body.trim();
        return b === "🔕" || /^silence(\s+\d+[mhd])?$/i.test(b);
      },
      handler: async (ctx) => {
        // Must be a Matrix reply to a known alert message
        const content = ctx.event.getContent() as Record<string, unknown>;
        const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
        const inReplyTo = relatesTo?.["m.in_reply_to"] as Record<string, unknown> | undefined;
        const replyToEventId = inReplyTo?.["event_id"] as string | undefined;

        if (!replyToEventId) return null;
        const record = alertEventMap.get(replyToEventId);
        if (!record) return null;

        if (!config.grafanaUrl || !config.grafanaToken) {
          return "❌ `GRAFANA_URL` or `GRAFANA_TOKEN` not configured — cannot create silence.";
        }

        const body = ctx.args.join(" ").trim();
        const durationMatch = body.match(/(\d+[mhd])$/i);
        const durationMs = durationMatch
          ? (parseDuration(durationMatch[1]!) ?? 3_600_000)
          : 3_600_000;
        const durationLabel = formatDuration(durationMs);

        const now    = new Date();
        const endsAt = new Date(now.getTime() + durationMs);

        try {
          await axios.post(
            `${config.grafanaUrl.replace(/\/$/, "")}/api/alertmanager/grafana/api/v2/silences`,
            {
              matchers:  [{ name: "alertname", value: record.alertname, isRegex: false }],
              startsAt:  now.toISOString(),
              endsAt:    endsAt.toISOString(),
              comment:   "Silenced via Lumi",
              createdBy: "lumi",
            },
            {
              headers: { Authorization: `Bearer ${config.grafanaToken}` },
              timeout: 10_000,
            },
          );
          alertEventMap.delete(replyToEventId);
          return `🔕 Silenced **${record.alertname}** for ${durationLabel}.`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `❌ Could not create silence: ${msg}`;
        }
      },
    });

    // ── HTTP webhook server ────────────────────────────────────────────────────

    registry.onStart(async (client) => {
      const server = http.createServer((req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405);
          res.end();
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          void (async () => {
            const body = Buffer.concat(chunks).toString("utf8");

            // HMAC verification (signature header is fixed; timestamp header is optional/configurable)
            if (secret) {
              const sig       = req.headers["x-grafana-alerting-signature"] as string | undefined;
              const timestamp = req.headers["x-grafana-alerting-timestamp"] as string | undefined;
              if (!sig || !verifyHmac(secret, body, sig, timestamp)) {
                log.warn("webhook HMAC verification failed — request rejected");
                res.writeHead(401);
                res.end();
                return;
              }
            }

            let payload: GrafanaPayload;
            try {
              payload = JSON.parse(body) as GrafanaPayload;
            } catch {
              log.warn("webhook received invalid JSON");
              res.writeHead(400);
              res.end();
              return;
            }

            res.writeHead(200);
            res.end();

            if (muted) {
              log.info("alert forwarding muted — dropping webhook");
              return;
            }

            for (const alert of payload.alerts ?? []) {
              if (alert.status === "resolved") {
                if (!forwardResolved) continue;
                resolvedCount++;
              } else {
                firingCount++;
              }

              const text = formatAlert(alert);

              for (const roomId of rooms) {
                try {
                  const sendResult = await client.sendMessage(roomId, {
                    msgtype: MsgType.Text,
                    body: text,
                    format: "org.matrix.custom.html",
                    formatted_body: renderHtml(text),
                  });

                  // Track firing alert event IDs for reply-to-silence
                  if (alert.status === "firing") {
                    alertEventMap.set(sendResult.event_id, {
                      alertname: alert.labels.alertname ?? "Unknown",
                      labels:    alert.labels,
                    });
                  }

                  // Attach rendered panel image if available
                  if (config.grafanaUrl) {
                    if (!alert.panelURL) {
                      log.info("no panelURL in webhook payload — skipping panel image");
                    } else if (alert.panelURL.includes("/d/dashboard_uid")) {
                      log.info("test alert panelURL — skipping panel render");
                    } else {
                      const renderUrl = panelUrlToRenderUrl(alert.panelURL, config.grafanaUrl, alert.status);
                      if (!renderUrl) {
                        log.warn("could not convert panelURL to render URL:", alert.panelURL);
                      } else {
                        try {
                          await renderAndUpload(client, roomId, renderUrl, config.grafanaToken);
                          log.info("panel image sent for", alert.labels.alertname);
                        } catch (err) {
                          log.warn("panel render failed:", err instanceof Error ? err.message : err);
                        }
                      }
                    }
                  }
                } catch (err) {
                  log.error(
                    `failed to send alert to ${roomId}:`,
                    err instanceof Error ? err.message : err,
                  );
                }
              }
            }
          })();
        });

        req.on("error", (err) => {
          log.error("webhook request error:", err.message);
          res.writeHead(500);
          res.end();
        });
      });

      server.listen(port, () => {
        log.info(`webhook listener started on port ${port}`);
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        log.error("webhook server error:", err.message);
      });
    });
  },
};

module.exports = mod;
// Exported for testing
module.exports.parseDuration     = parseDuration;
module.exports.formatDuration    = formatDuration;
module.exports.panelUrlToRenderUrl = panelUrlToRenderUrl;
module.exports.formatAlert       = formatAlert;
