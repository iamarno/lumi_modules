/**
 * Module: plants
 * Track plant care and send reminders when watering or fertilising is due.
 *
 * Commands:
 *   !plants                    — List all plants and their status
 *   !plants water <name>       — Mark a plant as watered now
 *   !plants fertilise <name>   — Mark a plant as fertilised now
 *   !plants skip <name>        — Snooze reminders by one interval
 *
 * Scheduled reminders (every hour, fires once per due period):
 *   "🪴 Monstera needs watering! Reply `watered` or `watered monstera` to confirm."
 *   User can reply conversationally — no ! command needed.
 *
 * Configuration via .env:
 *   PLANTS=monstera,fern,cactus
 *   PLANTS_ROOMS=!yourroom:matrix.org
 *
 *   PLANT_MONSTERA_WATER=7          — days between watering
 *   PLANT_MONSTERA_FERTILISE=30     — days between fertilising (0 = disabled)
 *   PLANT_MONSTERA_EMOJI=🌿         — optional emoji
 *
 *   PLANT_FERN_WATER=3
 *   PLANT_CACTUS_WATER=21
 *   PLANT_CACTUS_EMOJI=🌵
 */

import { BotModule, ModuleRegistry, CommandContext } from "lumi";
import { BotConfig, envInt, envList, env } from "lumi";
import { ModuleStore } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger('plants');

// ── Types ─────────────────────────────────────────────────────────────────────

interface PlantConfig {
  name: string;
  slug: string;
  waterDays: number;
  fertiliseDays: number;
  emoji: string;
}

interface PlantState {
  lastWatered: string | null;
  lastFertilised: string | null;
  waterReminderSent: string | null;
  fertiliseReminderSent: string | null;
}

const DEFAULT_STATE: PlantState = {
  lastWatered: null,
  lastFertilised: null,
  waterReminderSent: null,
  fertiliseReminderSent: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function daysUntilDue(last: string | null, intervalDays: number): number {
  if (!last) return 0;
  return intervalDays - (Date.now() - new Date(last).getTime()) / 86_400_000;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

function formatDue(days: number): string {
  const d = Math.floor(Math.abs(days));
  if (days < -0.5) return `${d} day${d === 1 ? "" : "s"} overdue`;
  if (days < 1)    return "due today";
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

function statusLine(plant: PlantConfig, state: PlantState): string {
  const waterDue = daysUntilDue(state.lastWatered, plant.waterDays);
  const lastW = state.lastWatered
    ? `last watered ${Math.floor(daysSince(state.lastWatered)!)}d ago`
    : "never watered";
  const lines = [
    `${plant.emoji} **${plant.name}**`,
    `  • Water: ${formatDue(waterDue)} (${lastW})`,
  ];
  if (plant.fertiliseDays > 0) {
    const fertDue = daysUntilDue(state.lastFertilised, plant.fertiliseDays);
    const lastF = state.lastFertilised
      ? `last fertilised ${Math.floor(daysSince(state.lastFertilised)!)}d ago`
      : "never fertilised";
    lines.push(`  • Fertilise: ${formatDue(fertDue)} (${lastF})`);
  }
  return lines.join("\n");
}

function findPlant(plants: PlantConfig[], name: string): PlantConfig | undefined {
  const q = name.toLowerCase();
  return plants.find((p) => p.slug === q || p.name.toLowerCase() === q);
}

// ── Config ────────────────────────────────────────────────────────────────────

function loadPlantConfigs(): PlantConfig[] {
  return envList("PLANTS").map((slug) => {
    const key = slug.toUpperCase();
    return {
      name: env(`PLANT_${key}_NAME`, slug),
      slug: slug.toLowerCase(),
      waterDays: envInt(`PLANT_${key}_WATER`, 7),
      fertiliseDays: envInt(`PLANT_${key}_FERTILISE`, 0),
      emoji: env(`PLANT_${key}_EMOJI`, "🪴"),
    };
  });
}

// ── Module ────────────────────────────────────────────────────────────────────

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.registerModule('plants', 'Track plant watering and fertilising schedules');

    const plants = loadPlantConfigs();
    const rooms = envList("PLANTS_ROOMS");
    const store = new ModuleStore("plants");

    // Tracks which plant slugs are awaiting confirmation per room (in-memory)
    const pending = new Map<string, Set<string>>();

    if (plants.length === 0) {
      log.info("no plants configured (set PLANTS in .env)");
      return;
    }

    // ── Commands ──────────────────────────────────────────────────────────────

    registry.register({
      name: "plants",
      module: 'plants',
      help: "Track plant watering and fertilising schedules",
      description: "Without arguments shows all plants and their last-watered/fertilised dates. Use water/fertilise to log an action, skip to defer.",
      usage: "[water|fertilise|skip <name>]",
      handler: async (ctx: CommandContext): Promise<string | null> => {
        const sub = ctx.args[0]?.toLowerCase();
        const name = ctx.args.slice(1).join(" ");

        if (!sub || sub === "list") {
          if (plants.length === 0) return "No plants configured.";
          return plants
            .map((p) => statusLine(p, store.get<PlantState>(p.slug, DEFAULT_STATE)))
            .join("\n\n");
        }

        const plant = findPlant(plants, name);

        if (sub === "water") {
          if (!plant) return `Unknown plant "${name}". Try \`!plants\` for the list.`;
          const state = store.get<PlantState>(plant.slug, { ...DEFAULT_STATE });
          state.lastWatered = new Date().toISOString();
          state.waterReminderSent = null;
          store.set(plant.slug, state);
          // Clear pending for this room
          for (const set of pending.values()) set.delete(plant.slug);
          return `${plant.emoji} **${plant.name}** watered. Next in ${plant.waterDays} day${plant.waterDays === 1 ? "" : "s"}.`;
        }

        if (sub === "fertilise" || sub === "fertilize") {
          if (!plant) return `Unknown plant "${name}". Try \`!plants\` for the list.`;
          if (plant.fertiliseDays === 0) return `${plant.emoji} **${plant.name}** has no fertilising schedule.`;
          const state = store.get<PlantState>(plant.slug, { ...DEFAULT_STATE });
          state.lastFertilised = new Date().toISOString();
          state.fertiliseReminderSent = null;
          store.set(plant.slug, state);
          return `${plant.emoji} **${plant.name}** fertilised. Next in ${plant.fertiliseDays} day${plant.fertiliseDays === 1 ? "" : "s"}.`;
        }

        if (sub === "skip") {
          if (!plant) return `Unknown plant "${name}". Try \`!plants\` for the list.`;
          const state = store.get<PlantState>(plant.slug, { ...DEFAULT_STATE });
          state.lastWatered = new Date().toISOString();
          state.waterReminderSent = null;
          store.set(plant.slug, state);
          for (const set of pending.values()) set.delete(plant.slug);
          return `${plant.emoji} **${plant.name}** snoozed for ${plant.waterDays} day${plant.waterDays === 1 ? "" : "s"}.`;
        }

        return "Usage: `!plants [water|fertilise|skip <name>]`";
      },
    });

    // ── Conversational reply handler ──────────────────────────────────────────

    registry.registerReply({
      name: "plants",
      match: (roomId, body) => {
        if (!pending.get(roomId)?.size) return false;
        const b = body.toLowerCase().trim();
        return (
          b === "yes" ||
          b === "done" ||
          b === "watered" ||
          b.startsWith("watered ") ||
          b === "ok"
        );
      },
      handler: async (ctx: CommandContext): Promise<string | null> => {
        const roomPending = pending.get(ctx.roomId);
        if (!roomPending?.size) return null;

        const body = ctx.event.getContent().body.toLowerCase().trim();
        const specificName = body.startsWith("watered ") ? body.slice(8).trim() : null;

        const toMark = specificName
          ? plants.filter((p) => roomPending.has(p.slug) && (p.slug === specificName || p.name.toLowerCase() === specificName))
          : plants.filter((p) => roomPending.has(p.slug));

        if (toMark.length === 0) return null;

        const now = new Date().toISOString();
        const confirmed: string[] = [];
        for (const plant of toMark) {
          const state = store.get<PlantState>(plant.slug, { ...DEFAULT_STATE });
          state.lastWatered = now;
          state.waterReminderSent = null;
          store.set(plant.slug, state);
          roomPending.delete(plant.slug);
          confirmed.push(`${plant.emoji} **${plant.name}**`);
        }

        return `Marked as watered: ${confirmed.join(", ")}. Next reminder in ${toMark[0]!.waterDays} day${toMark[0]!.waterDays === 1 ? "" : "s"}.`;
      },
    });

    // ── Scheduler ─────────────────────────────────────────────────────────────

    if (rooms.length > 0) {
      registry.schedule({
        name: "plants",
        intervalSecs: 3600,
        rooms,
        handler: async (): Promise<string | null> => {
          const now = new Date().toISOString();
          const due: string[] = [];
          let storeChanged = false;

          for (const plant of plants) {
            const state = store.get<PlantState>(plant.slug, { ...DEFAULT_STATE });

            if (daysUntilDue(state.lastWatered, plant.waterDays) <= 0) {
              const alreadySent = state.waterReminderSent
                ? daysUntilDue(state.waterReminderSent, plant.waterDays) > 0
                : false;
              if (!alreadySent) {
                due.push(`${plant.emoji} **${plant.name}** needs watering`);
                state.waterReminderSent = now;
                store.set(plant.slug, state);
                storeChanged = true;
                // Mark as pending for all rooms
                for (const roomId of rooms) {
                  if (!pending.has(roomId)) pending.set(roomId, new Set());
                  pending.get(roomId)!.add(plant.slug);
                }
              }
            }

            if (plant.fertiliseDays > 0 && daysUntilDue(state.lastFertilised, plant.fertiliseDays) <= 0) {
              const alreadySent = state.fertiliseReminderSent
                ? daysUntilDue(state.fertiliseReminderSent, plant.fertiliseDays) > 0
                : false;
              if (!alreadySent) {
                due.push(`${plant.emoji} **${plant.name}** needs fertilising`);
                state.fertiliseReminderSent = now;
                store.set(plant.slug, state);
              }
            }
          }

          if (due.length === 0) return null;

          const plantWord = due.length === 1 ? "plant" : "plants";
          return [
            `🪴 **${due.length} ${plantWord} need${due.length === 1 ? "s" : ""} attention:**`,
            ...due,
            `\nReply \`watered\` to mark all as done, or \`watered <name>\` for a specific plant.`,
          ].join("\n");
        },
      });

      log.info(`tracking ${plants.length} plant(s), reminders -> ${rooms.length} room(s)`);
    } else {
      log.info(`tracking ${plants.length} plant(s) — set PLANTS_ROOMS to enable reminders`);
    }
  },
};

module.exports = mod;
