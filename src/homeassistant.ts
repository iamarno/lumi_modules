/**
 * Module: homeassistant
 * Interact with Home Assistant via its REST API.
 *
 * Commands:
 *   !ha state <entity_id>          — get entity state + attributes
 *   !ha list [domain]              — list entities, optionally filtered by domain
 *   !ha turn_on <entity_id>        — call homeassistant.turn_on service
 *   !ha turn_off <entity_id>       — call homeassistant.turn_off service
 *   !ha toggle <entity_id>         — call homeassistant.toggle service
 */

import axios, { AxiosInstance } from "axios";
import { BotModule, ModuleRegistry, CommandContext, errMsg, env } from "lumi";
import { BotConfig } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger('homeassistant');

interface HassState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

const INTERESTING_ATTRS = [
  "unit_of_measurement",
  "friendly_name",
  "temperature",
  "humidity",
  "brightness",
  "color_temp",
  "battery_level",
  "device_class",
  "power",
  "voltage",
];

const mod: BotModule = {
  register(registry: ModuleRegistry, config: BotConfig) {
    registry.registerModule('homeassistant', 'Control and query Home Assistant entities');

    const hassUrl = env("HASS_URL", "http://homeassistant.local:8123");
    const hassToken = env("HASS_TOKEN");
    if (!hassToken) {
      log.warn("HASS_TOKEN not set — module disabled");
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

    registry.register({
      name: "ha",
      module: 'homeassistant',
      help: "Control Home Assistant",
      description: "Use state to read an entity, list to browse, or turn_on/turn_off/toggle to control a device. Entity IDs look like light.living_room.",
      usage: "<state|list|turn_on|turn_off|toggle> [entity_id]",
      handler: (ctx) => handler(ctx, http),
    });
  },
};

async function handler(
  ctx: CommandContext,
  http: AxiosInstance
): Promise<string> {
  const [sub, entityId] = ctx.args;

  if (!sub) {
    return [
      "**Home Assistant commands:**",
      "• `!ha state <entity_id>` — get entity state",
      "• `!ha list [domain]` — list entities (light, sensor, switch…)",
      "• `!ha turn_on <entity_id>` — turn on",
      "• `!ha turn_off <entity_id>` — turn off",
      "• `!ha toggle <entity_id>` — toggle",
    ].join("\n");
  }

  switch (sub.toLowerCase()) {
    case "state":
      if (!entityId) return "Usage: `!ha state <entity_id>`";
      return getState(http, entityId);

    case "list":
      return listEntities(http, entityId /* optional domain */);

    case "turn_on":
    case "turn_off":
    case "toggle":
      if (!entityId) return `Usage: \`!ha ${sub} <entity_id>\``;
      return callService(http, sub.toLowerCase(), entityId);

    default:
      return `❓ Unknown subcommand \`${sub}\`. Try \`!ha\` for help.`;
  }
}

async function getState(http: AxiosInstance, entityId: string): Promise<string> {
  try {
    const { data } = await http.get<HassState>(`/api/states/${entityId}`);
    const friendly = (data.attributes.friendly_name as string) ?? entityId;
    const lines = [
      `🏠 **${friendly}** (\`${entityId}\`)`,
      `**State:** \`${data.state}\``,
    ];
    for (const key of INTERESTING_ATTRS) {
      if (key in data.attributes && key !== "friendly_name") {
        lines.push(`**${key}:** \`${data.attributes[key]}\``);
      }
    }
    return lines.join("\n");
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return `❌ Entity \`${entityId}\` not found.`;
    }
    return hassError(err);
  }
}

async function listEntities(
  http: AxiosInstance,
  domain?: string
): Promise<string> {
  try {
    const { data } = await http.get<HassState[]>("/api/states");
    const filtered = domain
      ? data.filter((s) => s.entity_id.startsWith(`${domain}.`))
      : data;

    if (!filtered.length) {
      return domain
        ? `No entities found in domain \`${domain}\`.`
        : "No entities found.";
    }

    const sorted = filtered.sort((a, b) =>
      a.entity_id.localeCompare(b.entity_id)
    );
    const shown = sorted.slice(0, 20);
    const lines = [
      `🏠 **Entities${domain ? " in " + domain : ""}** (${filtered.length} total)\n`,
    ];
    for (const s of shown) {
      const friendly =
        (s.attributes.friendly_name as string | undefined) ?? s.entity_id;
      lines.push(`• \`${s.entity_id}\` — **${friendly}**: \`${s.state}\``);
    }
    if (filtered.length > 20) {
      lines.push(
        `_…and ${filtered.length - 20} more. Use \`!ha list <domain>\` to filter._`
      );
    }
    return lines.join("\n");
  } catch (err) {
    return hassError(err);
  }
}

async function callService(
  http: AxiosInstance,
  service: string,
  entityId: string
): Promise<string> {
  const domain = entityId.split(".")[0];
  try {
    await http.post(`/api/services/${domain}/${service}`, {
      entity_id: entityId,
    });
    const icons: Record<string, string> = {
      turn_on: "💡",
      turn_off: "🌑",
      toggle: "🔄",
    };
    return `${icons[service] ?? "✅"} \`${service}\` called on \`${entityId}\``;
  } catch (err) {
    return hassError(err);
  }
}

function hassError(err: unknown): string {
  if (axios.isAxiosError(err) && !err.response) {
    return `❌ Cannot reach Home Assistant`;
  }
  return `❌ Home Assistant error: ${errMsg(err)}`;
}

module.exports = mod;
