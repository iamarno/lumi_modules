/**
 * Module: water
 * Periodically reminds you to drink water.
 *
 * Configuration via .env:
 *   WATER_INTERVAL=3600            — reminder interval in seconds (default: 3600 = 1h, 0 = disabled)
 *   WATER_ROOMS=!abc:matrix.org   — comma-separated room IDs to post into
 *   WATER_WEEKDAY_HOURS=09:00-20:00  — active window on Mon–Fri (default: 09:00-20:00)
 *   WATER_WEEKEND_HOURS=11:00-20:00  — active window on Sat–Sun (default: 11:00-20:00)
 *
 * Chat commands:
 *   !water [status]       — show current state
 *   !water mute [30m|2h]  — mute indefinitely or for a duration
 *   !water unmute         — resume reminders
 */

import { BotModule, ModuleRegistry } from "lumi";
import { BotConfig, envInt, envList } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger('water');

const MESSAGES = [
  "💧 Time to drink some water!",
  "💧 Hydration check — grab a glass of water.",
  "💧 Don't forget to drink water!",
  "💧 Water break time.",
  "💧 Staying hydrated? Have a glass of water.",
  "💧 Your body is ~60% water. Top it up!",
  "💧 A glass of water a day keeps the headache away.",
  "💧 Still thirsty? You probably are — drink up.",
  "💧 Pro tip: drink water before you feel thirsty.",
  "💧 Quick break — fetch yourself a glass of water.",
  "💧 Hydration station calling your name.",
  "💧 Even plants need water. You do too.",
  "💧 Go drink some water. I'll wait.",
  "💧 Water o'clock.",
];

function randomMessage(): string {
  return MESSAGES[Math.floor(Math.random() * MESSAGES.length)]!;
}

/** Parse "HH:MM" into total minutes since midnight. */
function parseTime(t: string): number {
  const [h = 0, m = 0] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Parse "HH:MM-HH:MM" into [startMinutes, endMinutes]. */
function parseHoursRange(val: string): [number, number] {
  const [start, end] = val.split("-");
  return [parseTime(start!), parseTime(end!)];
}

/** Returns true if the current local time falls within the configured window. */
export function isInWindow(weekdayHours: string, weekendHours: string, now = new Date()): boolean {
  const day = now.getDay(); // 0=Sun, 6=Sat
  const isWeekend = day === 0 || day === 6;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [start, end] = parseHoursRange(isWeekend ? weekendHours : weekdayHours);
  return currentMinutes >= start && currentMinutes < end;
}

/** Parse a duration string like "30m" or "2h" into seconds, or null on failure. */
export function parseDuration(s: string): number | null {
  const m = /^(\d+)(h|m)$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return m[2]! === "h" ? n * 3600 : n * 60;
}

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.registerModule('water', 'Drinking water reminders');

    const intervalSecs = envInt("WATER_INTERVAL", 3600);
    const rooms = envList("WATER_ROOMS");
    const weekdayHours = process.env.WATER_WEEKDAY_HOURS ?? "09:00-20:00";
    const weekendHours = process.env.WATER_WEEKEND_HOURS ?? "11:00-20:00";

    if (intervalSecs === 0 || rooms.length === 0) {
      log.info("disabled (set WATER_INTERVAL and WATER_ROOMS to enable)");
      return;
    }

    // muteUntil === null  → not muted
    // muteUntil === 0     → muted indefinitely
    // muteUntil > 0       → muted until this ms timestamp
    let muteUntil: number | null = null;

    const isMuted = (): boolean => {
      if (muteUntil === null) return false;
      if (muteUntil === 0) return true;
      if (Date.now() < muteUntil) return true;
      muteUntil = null; // expired — clear automatically
      return false;
    };

    registry.schedule({
      name: "water",
      intervalSecs,
      rooms,
      handler: async () => {
        if (isMuted()) return null;
        if (!isInWindow(weekdayHours, weekendHours)) return null;
        return randomMessage();
      },
    });

    registry.register({
      name: "water",
      module: 'water',
      help: "Manage water reminders",
      description: "Sends reminders to drink water on a schedule. Mute temporarily silences reminders; unmute re-enables them.",
      usage: "[mute [duration] | unmute | status]",
      handler: async ({ args }) => {
        const sub = args[0]?.toLowerCase();

        if (!sub || sub === "status") {
          const muted = isMuted();
          let state: string;
          if (!muted) {
            state = isInWindow(weekdayHours, weekendHours)
              ? "active"
              : "active (currently outside scheduled hours)";
          } else if (muteUntil === 0) {
            state = "muted indefinitely";
          } else {
            state = `muted until ${new Date(muteUntil!).toLocaleTimeString()}`;
          }
          return (
            `💧 Water reminders: ${state}\n` +
            `Weekday: ${weekdayHours} · Weekend: ${weekendHours} · Interval: every ${intervalSecs / 60}m`
          );
        }

        if (sub === "mute") {
          const durStr = args[1];
          if (durStr) {
            const secs = parseDuration(durStr);
            if (secs === null) return `Invalid duration \`${durStr}\` — use e.g. \`30m\` or \`2h\`.`;
            muteUntil = Date.now() + secs * 1000;
            return `💧 Water reminders muted for ${durStr}.`;
          }
          muteUntil = 0;
          return "💧 Water reminders muted indefinitely. Use `!water unmute` to resume.";
        }

        if (sub === "unmute") {
          muteUntil = null;
          return "💧 Water reminders resumed.";
        }

        return "Usage: `!water [mute [duration] | unmute | status]`";
      },
    });
  },
};

module.exports = mod;
module.exports.isInWindow = isInWindow;
module.exports.parseDuration = parseDuration;
