/**
 * Module: sentinel
 * Home security and observation module.
 *
 * Commands:
 *   !sentinel arm          — Enter sentinel mode
 *   !sentinel disarm       — Return to observation mode
 *   !sentinel status       — Show current mode, armed time, configuration
 *   !sentinel summary      — Force a sensor summary right now
 *   !sentinel simulate     — Force one light simulation tick
 *
 * Configuration via .env:
 *   SENTINEL_ROOMS=!room:server                — Rooms for notifications (required)
 *   SENTINEL_SENSORS=binary_sensor.motion,...  — HA entity IDs to monitor
 *   SENTINEL_SUMMARY_INTERVAL=86400            — Seconds between summaries (default: 86400, 0=off)
 *   SENTINEL_SENSOR_POLL=60                    — Seconds between active sensor polls (default: 60, 0=off)
 *   SENTINEL_ALERT_COOLDOWN=600                — Seconds before re-alerting same sensor (default: 600)
 *   SENTINEL_BATTERY_WARN=20                   — Battery % threshold for warnings (default: 20, 0=off)
 *   SENTINEL_SIMULATION_LIGHTS=light.x,...     — Light entity IDs for at-home simulation
 *   SENTINEL_SIMULATION_INTERVAL=1800          — Seconds between simulation ticks (default: 1800)
 *   SENTINEL_SIM_MORNING=06:00-09:00           — Morning window: first half of lights on (default)
 *   SENTINEL_SIM_EVENING=18:00-23:00           — Evening window: all lights on (default)
 *   SENTINEL_PRESENCE_ENTITIES=person.alice     — HA person entities for auto arm/disarm
 *   SENTINEL_PRESENCE_POLL=300                 — Seconds between presence checks (default: 300, 0=off)
 *   SENTINEL_ARM_MODE=manual                   — Default arm mode: "auto" (presence-based) or "manual" (default: manual)
 *   SENTINEL_SUMMARY_MODE=armed               — When to send scheduled summary: "armed" (default) or "always"
 */

import axios, { AxiosInstance } from "axios";
import { MatrixClient, MsgType } from "matrix-js-sdk";
import { BotModule, ModuleRegistry, CommandContext, renderHtml, errMsg } from "lumi";
import { BotConfig, env, envInt, envList } from "lumi";
import { ModuleStore } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger("sentinel");

// ── Types ─────────────────────────────────────────────────────────────────────

interface SentinelState {
  mode: "sentinel" | "observation";
  armedAt: string | null;
  lastSummaryAt: string | null;
  armMode: "auto" | "manual";
  summaryMode: "armed" | "always";
}

const DEFAULT_STATE: SentinelState = {
  mode: "observation",
  armedAt: null,
  lastSummaryAt: null,
  armMode: "manual",
  summaryMode: "armed",
};

interface PresenceEvent {
  state: "all_away" | "someone_home";
  at: string;
}

interface HassState {
  entity_id: string;
  state: string;
  last_changed: string;
  attributes: Record<string, unknown>;
}

// ── HA helpers ────────────────────────────────────────────────────────────────

async function getEntityState(http: AxiosInstance, entityId: string): Promise<HassState> {
  const { data } = await http.get<HassState>(`/api/states/${entityId}`);
  return data;
}

async function callService(
  http: AxiosInstance,
  domain: string,
  service: string,
  entityId: string,
): Promise<void> {
  await http.post(`/api/services/${domain}/${service}`, { entity_id: entityId });
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function parseTimeRange(range: string): { startMin: number; endMin: number } {
  const [start, end] = range.split("-");
  const [sh = 0, sm = 0] = start!.split(":").map(Number);
  const [eh = 0, em = 0] = end!.split(":").map(Number);
  return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

function inTimeRange(nowMin: number, startMin: number, endMin: number): boolean {
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  // Midnight-spanning (e.g. 22:00–02:00)
  return nowMin >= startMin || nowMin < endMin;
}

function getSimPhase(morning: string, evening: string): "morning" | "evening" | "off" {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const m = parseTimeRange(morning);
  const e = parseTimeRange(evening);
  if (inTimeRange(nowMin, m.startMin, m.endMin)) return "morning";
  if (inTimeRange(nowMin, e.startMin, e.endMin)) return "evening";
  return "off";
}

// ── Simulation phase applier ──────────────────────────────────────────────────

async function applySimPhase(
  http: AxiosInstance,
  lights: string[],
  phase: "morning" | "evening" | "off",
): Promise<void> {
  const split = Math.ceil(lights.length / 2);
  for (let i = 0; i < lights.length; i++) {
    let service: string;
    if (phase === "off") {
      service = "turn_off";
    } else if (phase === "morning") {
      service = i < split ? "turn_on" : "turn_off";
    } else {
      // evening — all on
      service = "turn_on";
    }
    await callService(http, "light", service, lights[i]!);
  }
}

// ── Summary builder ───────────────────────────────────────────────────────────

async function buildSummary(
  http: AxiosInstance,
  sensors: string[],
  batteryWarn: number,
  presenceLog: PresenceEvent[] = [],
): Promise<string> {
  if (sensors.length === 0 && presenceLog.length === 0)
    return "🔒 Sentinel summary — no sensors configured.";

  const lines = ["🔒 **Sentinel summary**"];
  const batteryLines: string[] = [];

  for (const entityId of sensors) {
    try {
      const s = await getEntityState(http, entityId);
      const friendly = (s.attributes.friendly_name as string | undefined) ?? entityId;
      const ago = s.last_changed ? ` _(last changed ${timeAgo(s.last_changed)})_` : "";
      lines.push(`• \`${entityId}\` (${friendly}): \`${s.state}\`${ago}`);

      if (batteryWarn > 0) {
        const battery = s.attributes.battery_level;
        if (typeof battery === "number" && battery <= batteryWarn) {
          batteryLines.push(`⚠️ Low battery: \`${entityId}\` — ${battery}%`);
        }
      }
    } catch {
      lines.push(`• \`${entityId}\`: ❌ unavailable`);
    }
  }

  if (batteryLines.length > 0) {
    lines.push("", ...batteryLines);
  }

  if (presenceLog.length > 0) {
    const last = presenceLog[presenceLog.length - 1]!;
    const currentLabel = last.state === "someone_home" ? "Someone home" : "All away";
    lines.push("", `📍 **Presence** — ${currentLabel} (since ${timeAgo(last.at)})`);
    if (presenceLog.length > 1) {
      lines.push(`_${presenceLog.length - 1} transition(s) this period_`);
      for (const event of presenceLog.slice(-5)) {
        const icon = event.state === "someone_home" ? "🏠" : "🚶";
        const label = event.state === "someone_home" ? "Someone arrived" : "Everyone left";
        lines.push(`• ${icon} ${label} — ${timeAgo(event.at)}`);
      }
    }
  }

  return lines.join("\n");
}

// ── Presence check ────────────────────────────────────────────────────────────

async function checkPresence(
  http: AxiosInstance,
  presenceEntities: string[],
): Promise<"all_away" | "someone_home" | "unknown"> {
  const states: string[] = [];
  for (const entityId of presenceEntities) {
    try {
      const s = await getEntityState(http, entityId);
      states.push(s.state);
    } catch {
      return "unknown";
    }
  }
  if (states.every((s) => s === "not_home")) return "all_away";
  if (states.some((s) => s === "home")) return "someone_home";
  return "unknown";
}

// ── Matrix helper ─────────────────────────────────────────────────────────────

async function sendToRooms(
  client: MatrixClient,
  rooms: string[],
  text: string,
): Promise<void> {
  for (const roomId of rooms) {
    await client.sendMessage(roomId, {
      msgtype: MsgType.Text,
      body: text,
      format: "org.matrix.custom.html",
      formatted_body: renderHtml(text),
    });
  }
}

// ── onStart: active sensor monitor ────────────────────────────────────────────

function startSensorMonitor(
  client: MatrixClient,
  store: ModuleStore,
  http: AxiosInstance,
  sensors: string[],
  rooms: string[],
  pollSecs: number,
  cooldownSecs: number,
): void {
  const lastState = new Map<string, string>();
  const cooldownUntil = new Map<string, number>();

  async function tick(): Promise<void> {
    const state = store.get<SentinelState>("state", DEFAULT_STATE);
    if (state.mode === "sentinel") {
      for (const entityId of sensors) {
        try {
          const s = await getEntityState(http, entityId);
          const prev = lastState.get(entityId);
          if (prev !== undefined && s.state !== prev) {
            if (Date.now() > (cooldownUntil.get(entityId) ?? 0)) {
              await sendToRooms(
                client,
                rooms,
                `🚨 Sentinel alert: \`${entityId}\` changed to \`${s.state}\``,
              );
              cooldownUntil.set(entityId, Date.now() + cooldownSecs * 1_000);
            }
          }
          lastState.set(entityId, s.state);
        } catch (err) {
          log.error(`sensor monitor error for ${entityId}:`, errMsg(err));
        }
      }
    }
    setTimeout(tick, pollSecs * 1_000);
  }

  // Extra startup delay so initial states populate without triggering false alerts
  setTimeout(tick, 15_000);
  log.info(
    `sensor monitor armed (poll=${pollSecs}s, cooldown=${cooldownSecs}s, ${sensors.length} sensor(s))`,
  );
}

// ── onStart: light simulation loop ────────────────────────────────────────────

function startSimulation(
  store: ModuleStore,
  http: AxiosInstance,
  lights: string[],
  intervalSecs: number,
  morning: string,
  evening: string,
): void {
  async function tick(): Promise<void> {
    const state = store.get<SentinelState>("state", DEFAULT_STATE);
    if (state.mode === "sentinel") {
      try {
        const phase = getSimPhase(morning, evening);
        await applySimPhase(http, lights, phase);
        log.debug(`simulation tick: ${phase} phase → ${lights.length} light(s)`);
      } catch (err) {
        log.error("simulation error:", errMsg(err));
      }
    }
    setTimeout(tick, intervalSecs * 1_000);
  }
  setTimeout(tick, 5_000);
  log.info(
    `simulation armed (interval=${intervalSecs}s, ${lights.length} light(s), morning=${morning}, evening=${evening})`,
  );
}

// ── onStart: presence polling loop ────────────────────────────────────────────

function startPresencePolling(
  client: MatrixClient,
  store: ModuleStore,
  http: AxiosInstance,
  presenceEntities: string[],
  rooms: string[],
  pollSecs: number,
): void {
  async function tick(): Promise<void> {
    try {
      const state = store.get<SentinelState>("state", DEFAULT_STATE);
      const presence = await checkPresence(http, presenceEntities);

      // Log presence transitions (regardless of armMode)
      if (presence !== "unknown") {
        const log = store.get<PresenceEvent[]>("presenceLog", []);
        const last = log[log.length - 1];
        if (!last || last.state !== presence) {
          store.set("presenceLog", [...log, { state: presence, at: new Date().toISOString() }].slice(-100));
        }
      }

      if ((state.armMode ?? "manual") === "auto") {
        if (presence === "all_away" && state.mode === "observation") {
          const now = new Date().toISOString();
          store.set("state", { ...state, mode: "sentinel", armedAt: now });
          log.info("auto-armed: all presence entities are not_home");
          await sendToRooms(client, rooms, "🔒 Sentinel armed automatically (nobody home)");
        } else if (presence === "someone_home" && state.mode === "sentinel") {
          store.set("state", { ...state, mode: "observation", armedAt: null });
          log.info("auto-disarmed: someone returned home");
          await sendToRooms(client, rooms, "🏠 Sentinel disarmed — welcome home");
        }
      }
    } catch (err) {
      log.error("presence poll error:", errMsg(err));
    }
    setTimeout(tick, pollSecs * 1_000);
  }
  setTimeout(tick, 10_000);
  log.info(`presence polling armed (interval=${pollSecs}s, ${presenceEntities.length} entity/entities)`);
}

// ── Module ────────────────────────────────────────────────────────────────────

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    registry.registerModule('sentinel', 'Home security monitoring and light simulation');

    const rooms = envList("SENTINEL_ROOMS");
    const hassUrl = env("HASS_URL", "http://homeassistant.local:8123");
    const hassToken = env("HASS_TOKEN");

    if (!hassToken || rooms.length === 0) {
      log.info("disabled — set SENTINEL_ROOMS and HASS_TOKEN to enable");
      return;
    }

    const http = axios.create({
      baseURL: hassUrl,
      headers: {
        Authorization: `Bearer ${hassToken}`,
        "Content-Type": "application/json",
      },
      timeout: 12_000,
    });

    const store = new ModuleStore("sentinel");

    // Seed armMode / summaryMode from env on first run, or migrate stored state missing fields
    const rawArm = env("SENTINEL_ARM_MODE", "manual");
    const defaultArmMode: "auto" | "manual" = rawArm === "auto" ? "auto" : "manual";
    const rawSummary = env("SENTINEL_SUMMARY_MODE", "armed");
    const defaultSummaryMode: "armed" | "always" = rawSummary === "always" ? "always" : "armed";
    const existingState = store.get<SentinelState | null>("state", null);
    if (
      existingState === null ||
      existingState.armMode === undefined ||
      existingState.summaryMode === undefined
    ) {
      store.set("state", {
        ...(existingState ?? DEFAULT_STATE),
        armMode: existingState?.armMode ?? defaultArmMode,
        summaryMode: existingState?.summaryMode ?? defaultSummaryMode,
      });
    }

    const sensors = envList("SENTINEL_SENSORS");
    const summaryInterval = envInt("SENTINEL_SUMMARY_INTERVAL", 86_400);
    const sensorPoll = envInt("SENTINEL_SENSOR_POLL", 60);
    const alertCooldown = envInt("SENTINEL_ALERT_COOLDOWN", 600);
    const batteryWarn = envInt("SENTINEL_BATTERY_WARN", 20);
    const simulationLights = envList("SENTINEL_SIMULATION_LIGHTS");
    const simulationInterval = envInt("SENTINEL_SIMULATION_INTERVAL", 1_800);
    const simMorning = env("SENTINEL_SIM_MORNING", "06:00-09:00");
    const simEvening = env("SENTINEL_SIM_EVENING", "18:00-23:00");
    const presenceEntities = envList("SENTINEL_PRESENCE_ENTITIES");
    const presencePoll = envInt("SENTINEL_PRESENCE_POLL", 300);

    // ── Commands ──────────────────────────────────────────────────────────────

    registry.register({
      name: "sentinel",
      module: 'sentinel',
      help: "Home security and observation",
      usage: "<arm|disarm|armmode|summarymode|status|summary|simulate>",
      handler: async (ctx: CommandContext): Promise<string> => {
        const sub = ctx.args[0]?.toLowerCase();
        const state = store.get<SentinelState>("state", DEFAULT_STATE);

        switch (sub) {
          case "arm": {
            if (state.mode === "sentinel") return "Already in sentinel mode.";
            const now = new Date().toISOString();
            store.set("state", { ...state, mode: "sentinel", armedAt: now });
            return "🔒 Sentinel mode armed.";
          }

          case "disarm": {
            if (state.mode === "observation") return "Already in observation mode.";
            store.set("state", { ...state, mode: "observation", armedAt: null });
            return "🏠 Sentinel disarmed. Returning to observation mode.";
          }

          case "armmode": {
            const newMode = ctx.args[1]?.toLowerCase();
            if (!newMode) {
              const current = state.armMode ?? defaultArmMode;
              return `**Arm mode:** \`${current}\`\n• \`auto\` — arm/disarm automatically based on presence\n• \`manual\` — only \`!sentinel arm\` / \`disarm\` change the mode`;
            }
            if (newMode !== "auto" && newMode !== "manual") {
              return "Unknown arm mode. Use `auto` or `manual`.";
            }
            store.set("state", { ...state, armMode: newMode });
            return newMode === "auto"
              ? "🔄 Arm mode set to **auto** — sentinel will arm when everyone leaves home."
              : "Arm mode set to **manual** — use `!sentinel arm` / `disarm` to control.";
          }

          case "summarymode": {
            const newMode = ctx.args[1]?.toLowerCase();
            if (!newMode) {
              const current = state.summaryMode ?? defaultSummaryMode;
              return `**Summary mode:** \`${current}\`\n• \`armed\` — only send scheduled summary when sentinel mode is active\n• \`always\` — send scheduled summary regardless of mode`;
            }
            if (newMode !== "armed" && newMode !== "always") {
              return "Unknown summary mode. Use `armed` or `always`.";
            }
            store.set("state", { ...state, summaryMode: newMode });
            return newMode === "always"
              ? "Summary mode set to **always** — scheduled summaries will send regardless of sentinel mode."
              : "Summary mode set to **armed** — scheduled summaries only send when sentinel mode is active.";
          }

          case "status": {
            const lines = ["🔒 **Sentinel status**", `**Mode:** ${state.mode}`];
            lines.push(`**Arm mode:** ${state.armMode ?? defaultArmMode}`);
            lines.push(`**Summary mode:** ${state.summaryMode ?? defaultSummaryMode}`);
            if (state.armedAt) {
              lines.push(`**Armed at:** ${new Date(state.armedAt).toLocaleString()}`);
            }
            if (state.lastSummaryAt) {
              lines.push(`**Last summary:** ${new Date(state.lastSummaryAt).toLocaleString()}`);
            }
            lines.push(`**Sensors:** ${sensors.length > 0 ? sensors.join(", ") : "none"}`);
            lines.push(
              `**Simulation lights:** ${simulationLights.length > 0 ? simulationLights.join(", ") : "none"}`,
            );
            lines.push(
              `**Simulation schedule:** morning ${simMorning}, evening ${simEvening}`,
            );
            lines.push(
              `**Presence entities:** ${presenceEntities.length > 0 ? presenceEntities.join(", ") : "none"}`,
            );
            return lines.join("\n");
          }

          case "summary": {
            const presenceLog = store.get<PresenceEvent[]>("presenceLog", []);
            const text = await buildSummary(http, sensors, batteryWarn, presenceLog);
            const fresh = store.get<SentinelState>("state", DEFAULT_STATE);
            store.set("state", { ...fresh, lastSummaryAt: new Date().toISOString() });
            return text;
          }

          case "simulate": {
            if (simulationLights.length === 0)
              return "No simulation lights configured (set SENTINEL_SIMULATION_LIGHTS).";
            const phase = getSimPhase(simMorning, simEvening);
            await applySimPhase(http, simulationLights, phase);
            return `💡 Simulation tick (${phase} phase): applied to ${simulationLights.length} light(s).`;
          }

          default:
            return [
              "**Sentinel commands:**",
              "• `!sentinel arm` — enter sentinel mode",
              "• `!sentinel disarm` — return to observation",
              "• `!sentinel armmode [auto|manual]` — show or set arm mode",
              "• `!sentinel summarymode [armed|always]` — show or set when scheduled summaries send",
              "• `!sentinel status` — show current mode and configuration",
              "• `!sentinel summary` — query sensors and report now (includes presence, last-changed times, battery warnings)",
              "• `!sentinel simulate` — run one light simulation tick (time-of-day phase)",
            ].join("\n");
        }
      },
    });

    // ── Scheduled summary ─────────────────────────────────────────────────────

    registry.schedule({
      name: "sentinel:summary",
      intervalSecs: summaryInterval,
      rooms,
      handler: async () => {
        const state = store.get<SentinelState>("state", DEFAULT_STATE);
        if ((state.summaryMode ?? "armed") === "armed" && state.mode !== "sentinel") return null;
        const presenceLog = store.get<PresenceEvent[]>("presenceLog", []);
        const text = await buildSummary(http, sensors, batteryWarn, presenceLog);
        const fresh = store.get<SentinelState>("state", DEFAULT_STATE);
        store.set("state", { ...fresh, lastSummaryAt: new Date().toISOString() });
        store.set("presenceLog", []); // reset after scheduled summary
        return text;
      },
    });

    // ── onStart: active sensor monitor ────────────────────────────────────────

    if (sensors.length > 0 && sensorPoll > 0) {
      registry.onStart(async (client) => {
        startSensorMonitor(client, store, http, sensors, rooms, sensorPoll, alertCooldown);
      });
    }

    // ── onStart: simulation loop ───────────────────────────────────────────────

    if (simulationLights.length > 0 && simulationInterval > 0) {
      registry.onStart(async () => {
        startSimulation(store, http, simulationLights, simulationInterval, simMorning, simEvening);
      });
    }

    // ── onStart: presence polling ─────────────────────────────────────────────

    if (presenceEntities.length > 0 && presencePoll > 0) {
      registry.onStart(async (client) => {
        startPresencePolling(client, store, http, presenceEntities, rooms, presencePoll);
      });
    }

    const features = [
      sensors.length > 0 && `${sensors.length} sensor(s)`,
      summaryInterval > 0 && `summary every ${summaryInterval}s`,
      sensors.length > 0 && sensorPoll > 0 && `active alerts (poll=${sensorPoll}s)`,
      simulationLights.length > 0 && `simulation (${simulationLights.length} light(s))`,
      presenceEntities.length > 0 && `presence polling (${presenceEntities.length} entity/entities)`,
    ]
      .filter(Boolean)
      .join(", ");
    log.info(`registered — ${features || "no optional features configured"}`);
  },
};

module.exports = mod;
// Exported for testing
module.exports.timeAgo = timeAgo;
module.exports.getSimPhase = getSimPhase;
