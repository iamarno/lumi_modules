/**
 * Module: prometheus
 * Query a Prometheus instance via its HTTP API.
 *
 * Built-in commands:
 *   !prom query <PromQL>    — instant query
 *   !prom targets           — active scrape targets
 *   !prom alerts            — firing alerts
 *
 * Named shortcuts (configured via .env):
 *   PROM_SHORTCUTS=cpu,mem
 *
 *   PROM_cpu_QUERY=rate(node_cpu_seconds_total{mode!="idle"}[5m])
 *   PROM_cpu_CMD=cpu                      # chat command name (default: prom-cpu)
 *   PROM_cpu_HELP=CPU usage rate          # shown in !help
 *   PROM_cpu_INTERVAL=86400              # auto-post every N seconds (0 = disabled)
 *   PROM_cpu_ROOMS=!abc:matrix.org,!def:matrix.org
 *
 *   PROM_mem_QUERY=node_memory_MemAvailable_bytes
 *   PROM_mem_CMD=mem
 *   PROM_mem_HELP=Available memory
 *   # no PROM_mem_INTERVAL → command only, no auto-post
 */

import axios from "axios";
import { BotModule, ModuleRegistry, CommandContext, errMsg } from "lumi";
import { BotConfig, env, envInt, envList } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger('prometheus');

interface PrometheusResult {
  metric: Record<string, string>;
  value: [number, string];
}

interface Target {
  labels: Record<string, string>;
  health: string;
}

interface Alert {
  labels: Record<string, string>;
  annotations: Record<string, string>;
  state: string;
}

interface PrometheusQueryResponse {
  status: string;
  error?: string;
  data: { result: PrometheusResult[] };
}

interface PrometheusTargetsResponse {
  data: { activeTargets: Target[] };
}

interface PrometheusAlertsResponse {
  data: { alerts: Alert[] };
}

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    registry.registerModule('prometheus', 'Query Prometheus metrics');

    const base = config.prometheusUrl;

    registry.register({
      name: "prom",
      module: 'prometheus',
      help: "Query Prometheus",
      description: "Use query for instant PromQL, targets to list scrape targets, alerts to list firing alerts.",
      usage: "<query|targets|alerts> [PromQL]",
      handler: async (ctx) => handler(ctx, base),
    });

    // ── Named shortcuts ──────────────────────────────────────────────────────
    // PROM_SHORTCUTS=cpu,mem  →  each name defines a query shortcut
    for (const name of envList("PROM_SHORTCUTS")) {
      const prefix = `PROM_${name.toUpperCase()}`;
      const query = env(`${prefix}_QUERY`);
      if (!query) {
        log.warn(`shortcut "${name}" has no ${prefix}_QUERY, skipping`);
        continue;
      }

      const cmd      = env(`${prefix}_CMD`, `prom-${name}`);
      const help     = env(`${prefix}_HELP`, `PromQL: ${query}`);
      const interval = envInt(`${prefix}_INTERVAL`, 0);
      const rooms    = envList(`${prefix}_ROOMS`);

      // Register as a chat command
      registry.register({ name: cmd, module: 'prometheus', help, handler: () => instantQuery(base, query) });

      // Optionally schedule automatic posting
      if (interval > 0 && rooms.length > 0) {
        registry.schedule({
          name: `prom:${name}`,
          intervalSecs: interval,
          rooms,
          handler: () => instantQuery(base, query),
        });
      }
    }
  },
};

async function handler(ctx: CommandContext, base: string): Promise<string> {
  const [sub, ...rest] = ctx.args;

  if (!sub) {
    return [
      "**Prometheus commands:**",
      "• `!prom query <PromQL>` — instant query",
      "• `!prom targets` — scrape targets",
      "• `!prom alerts` — firing alerts",
    ].join("\n");
  }

  switch (sub.toLowerCase()) {
    case "query":
      if (!rest.length) return "Usage: `!prom query <PromQL>`";
      return instantQuery(base, rest.join(" "));
    case "targets":
      return targets(base);
    case "alerts":
      return alerts(base);
    default:
      // Treat the whole args as a PromQL shorthand
      return instantQuery(base, ctx.args.join(" "));
  }
}

async function instantQuery(base: string, promql: string): Promise<string> {
  try {
    const { data } = await axios.get<PrometheusQueryResponse>(`${base}/api/v1/query`, {
      params: { query: promql },
      timeout: 10_000,
    });

    if (data.status !== "success") {
      return `❌ Prometheus error: ${data.error ?? "unknown"}`;
    }

    const results = data.data.result;
    if (!results.length) {
      return `📊 No results for: \`${promql}\``;
    }

    const lines = [`📊 **Prometheus:** \`${promql}\`\n`];
    for (const item of results.slice(0, 10)) {
      const name = item.metric.__name__ ?? "value";
      const labels = Object.entries(item.metric)
        .filter(([k]) => k !== "__name__")
        .map(([k, v]) => `${k}="${v}"`)
        .join(", ");
      lines.push(`• **${name}**{${labels}} = \`${item.value[1]}\``);
    }
    if (results.length > 10) {
      lines.push(`_…and ${results.length - 10} more_`);
    }
    return lines.join("\n");
  } catch (err) {
    return connError(err, base);
  }
}

async function targets(base: string): Promise<string> {
  try {
    const { data } = await axios.get<PrometheusTargetsResponse>(`${base}/api/v1/targets`, {
      timeout: 10_000,
    });
    const active = data.data.activeTargets ?? [];
    const lines = [`🎯 **Targets** (${active.length} active)\n`];
    for (const t of active.slice(0, 15)) {
      const icon = t.health === "up" ? "✅" : "❌";
      const job = t.labels.job ?? "?";
      const instance = t.labels.instance ?? "?";
      lines.push(`${icon} \`${job}\` — ${instance}`);
    }
    return lines.join("\n");
  } catch (err) {
    return connError(err, base);
  }
}

async function alerts(base: string): Promise<string> {
  try {
    const { data } = await axios.get<PrometheusAlertsResponse>(`${base}/api/v1/alerts`, {
      timeout: 10_000,
    });
    const firing = (data.data.alerts ?? []).filter(
      (a: Alert) => a.state === "firing"
    );
    if (!firing.length) return "✅ No firing alerts.";

    const lines = [`🔔 **Firing Alerts** (${firing.length})\n`];
    for (const a of firing.slice(0, 10)) {
      const name = a.labels.alertname ?? "?";
      const severity = a.labels.severity ?? "?";
      const summary = a.annotations.summary ?? "";
      lines.push(
        `• 🔴 **${name}** [${severity}]${summary ? " — " + summary : ""}`
      );
    }
    return lines.join("\n");
  } catch (err) {
    return connError(err, base);
  }
}

function connError(err: unknown, base: string): string {
  if (axios.isAxiosError(err) && !err.response) {
    return `❌ Cannot reach Prometheus at \`${base}\``;
  }
  return `❌ Prometheus error: ${errMsg(err)}`;
}

module.exports = mod;
