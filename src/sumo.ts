/**
 * Module: sumo
 * Sumo wrestling information.
 *
 * Commands:
 *   !sumo rikishi <name>            — Look up a rikishi (partial name, via sumostats.com)
 *   !sumo rikishi <name> --official — Look up via sumo-api.com (exact match)
 *   !sumo favorite                  — Show your configured favourite rikishi
 *   !sumo basho                     — Next/current tournament dates and locations
 *   !sumo today                     — Live standings during an active basho
 *   !sumo banzuke [division]        — Banzuke (ranking list) for the current basho
 *   !sumo rules                     — Basic sumo rules overview
 *   !sumo term <word>               — Look up a sumo term or concept
 *
 * Configuration via .env:
 *   SUMO_FAVORITE=terunofuji   — Shikona slug of your favourite rikishi (lowercase, no spaces)
 *
 * Default data source: https://sumostats.com (partial name search, ELO ratings)
 * Alternate source:    https://sumo-api.com  (--official flag, exact match)
 */

import axios from "axios";
import { BotModule, ModuleRegistry, CommandContext, errMsg } from "lumi";
import { BotConfig, env } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger('sumo');

const SUMOSTATS_BASE = "https://sumostats.com/api";
const SUMOAPI_BASE = "https://sumo-api.com/api";

const RANK_TIER: Record<string, string> = {
  Y: "Yokozuna", O: "Ozeki", S: "Sekiwake", K: "Komusubi",
  M: "Maegashira", J: "Juryo", Ms: "Makushita", Sd: "Sandanme",
  Jd: "Jonidan", Jo: "Jonokuchi",
};

function expandRank(rank: string): string {
  const m = rank.match(/^([A-Za-z]+)(\d+)([ew])$/i);
  if (!m) return rank;
  const tier = RANK_TIER[m[1]!] ?? m[1]!;
  const side = m[3]!.toLowerCase() === "e" ? "East" : "West";
  return `${tier} ${m[2]!} ${side}`;
}

// ── Static data ───────────────────────────────────────────────────────────────

const RULES = `**Basic Sumo Rules**

• The bout begins when both wrestlers touch both fists to the ground (tachi-ai).
• You lose if any part of your body other than the soles of your feet touches the ground.
• You lose if you step outside the tawara (straw bales marking the ring boundary).
• No punching with a closed fist, eye-gouging, hair-pulling (except the mage/topknot), or choking.
• There are 82 recognised winning techniques (kimarite).
• Bouts are decided in seconds — the longest rarely exceed a minute.
• A tournament (basho) lasts 15 days; wrestlers compete once per day.
• The wrestler with the most wins takes the Emperor's Cup.`;

const TERMS: Record<string, string> = {
  basho: "A sumo tournament. There are 6 per year, each lasting 15 days.",
  rikishi: "A sumo wrestler.",
  yokozuna: "The highest rank in sumo. Promotion is permanent — a yokozuna cannot be demoted, only expected to retire when results decline.",
  ozeki: "The second-highest rank. Two consecutive poor tournaments (kadoban) risk demotion.",
  sekiwake: "Third-highest rank in the sanyaku (top ranks).",
  komusubi: "Fourth-highest rank in the sanyaku.",
  maegashira: "The main division (makuuchi) rank below sanyaku. Numbered 1–17, with lower numbers being stronger positions.",
  makuuchi: "The top division in sumo, comprising ~42 wrestlers.",
  juryo: "The second division — wrestlers here earn a salary and wear the kesho-mawashi apron.",
  "tachi-ai": "The initial charge at the start of a bout.",
  mawashi: "The belt/loincloth worn by wrestlers during bouts.",
  dohyo: "The clay ring, 4.55 m in diameter, surrounded by tawara (straw bales).",
  tawara: "Partially buried straw bales forming the boundary of the dohyo.",
  kimarite: "The winning technique used to decide a bout. There are 82 recognised kimarite.",
  gyoji: "The referee inside the ring, dressed in traditional court clothing.",
  shimpan: "The judges seated around the ring who can call a mono-ii (judges' conference).",
  "mono-ii": "A judges' conference called to review a close or disputed bout outcome.",
  keiko: "Training/practice.",
  heya: "A sumo stable — the training house where wrestlers live and train together.",
  banzuke: "The official ranking list published before each basho.",
  kachi: "A win.",
  make: "A loss.",
  "kachi-koshi": "Achieving a winning record (8+ wins in 15 bouts) — results in promotion.",
  "make-koshi": "A losing record (8+ losses) — results in demotion.",
  zensho: "A perfect tournament — 15 wins, 0 losses.",
  yusho: "Tournament championship.",
  kinboshi: "A gold star award given to a maegashira wrestler who defeats a yokozuna.",
  henka: "A side-step at the tachi-ai to avoid the opponent's charge — legal but often considered unsportsmanlike.",
  oshi: "Pushing techniques.",
  yotsu: "Grappling/belt-fighting techniques.",
  uwate: "An overarm grip on the opponent's mawashi.",
  shitate: "An underarm grip on the opponent's mawashi.",
  yorikiri: "Force out — the most common kimarite, pushing the opponent out while holding the mawashi.",
  oshidashi: "Push out — pushing the opponent out without a belt grip.",
  hatakikomi: "Slap down — pulling the opponent down by their head or shoulder.",
  uwatenage: "Overarm throw.",
  shitatenage: "Underarm throw.",
};

// Basho schedule: 6 per year — Jan, Mar, May, Jul, Sep, Nov
// Odd months start on the 2nd Sunday; this table lists confirmed 2025–2026 dates.
const BASHO_SCHEDULE = [
  { name: "Hatsu Basho (New Year)",     location: "Ryogoku Kokugikan, Tokyo",       start: new Date("2025-01-12"), end: new Date("2025-01-26") },
  { name: "Haru Basho (Spring)",        location: "Edion Arena, Osaka",              start: new Date("2025-03-09"), end: new Date("2025-03-23") },
  { name: "Natsu Basho (Summer)",       location: "Ryogoku Kokugikan, Tokyo",       start: new Date("2025-05-11"), end: new Date("2025-05-25") },
  { name: "Nagoya Basho",               location: "Dolphins Arena, Nagoya",          start: new Date("2025-07-13"), end: new Date("2025-07-27") },
  { name: "Aki Basho (Autumn)",         location: "Ryogoku Kokugikan, Tokyo",       start: new Date("2025-09-14"), end: new Date("2025-09-28") },
  { name: "Kyushu Basho",              location: "Marine Messe Fukuoka Hall B",      start: new Date("2025-11-09"), end: new Date("2025-11-23") },
  { name: "Hatsu Basho (New Year)",     location: "Ryogoku Kokugikan, Tokyo",       start: new Date("2026-01-11"), end: new Date("2026-01-25") },
  { name: "Haru Basho (Spring)",        location: "Edion Arena, Osaka",              start: new Date("2026-03-08"), end: new Date("2026-03-22") },
];

// ── Basho helpers ─────────────────────────────────────────────────────────────

type BashoEntry = typeof BASHO_SCHEDULE[number];

function bashoToId(b: BashoEntry): number {
  return b.start.getFullYear() * 100 + (b.start.getMonth() + 1);
}

function getActiveBasho(): { basho: BashoEntry; day: number; id: number } | null {
  const now = new Date();
  const active = BASHO_SCHEDULE.find((b) => b.start <= now && b.end >= now);
  if (!active) return null;
  const day = Math.floor((now.getTime() - active.start.getTime()) / 86_400_000) + 1;
  return { basho: active, day: Math.min(day, 15), id: bashoToId(active) };
}

function getMostRecentBasho(): { basho: BashoEntry; id: number } | null {
  const now = new Date();
  const started = BASHO_SCHEDULE.filter((b) => b.start <= now);
  if (started.length === 0) return null;
  const b = started[started.length - 1]!;
  return { basho: b, id: bashoToId(b) };
}

// ── API helpers ───────────────────────────────────────────────────────────────

interface RikishiSumostats {
  id: number;
  shikona: string;
  shikona_kanji: string;
  birth_date: string;
  height: number;
  weight: number;
  rank: string;
  highest_rank: string;
  country: string;
  prefecture: string | null;
  total_wins: number;
  total_losses: number;
  total_absents: number | null;
  current_elo: number;
  retired_basho: string | null;
  heya: { name: string; heya_id: number };
}

interface RikishiBasic {
  id: number;
  sumodbId: number;
  nskId: number;
  shikonaEn: string;
  shikonaJp: string;
  currentRank: string;
  heya: string;
  birthDate: string;
  shusshin: string; // hometown
  height: number;
  weight: number;
  debut: string;
}

interface BanzukeEntry {
  rank_letter: string;   // Y, O, S, K, M, J, Ms, Sd, Jd, Jo
  rank_number: number;
  rank_side: string;     // 'e' or 'w'
  is_east: boolean;
  division: string;      // 'Makuuchi', 'Juryo', etc.
  wins: number;
  losses: number;
  misses: number;
  names: { shikona: string };
}

const TIER_ORDER: Record<string, number> = {
  Y: 0, O: 1, S: 2, K: 3, M: 4, J: 5, Ms: 6, Sd: 7, Jd: 8, Jo: 9,
};

function sortBanzukeEntry(a: BanzukeEntry, b: BanzukeEntry): number {
  const at = TIER_ORDER[a.rank_letter] ?? 9;
  const bt = TIER_ORDER[b.rank_letter] ?? 9;
  if (at !== bt) return at - bt;
  if (a.rank_number !== b.rank_number) return a.rank_number - b.rank_number;
  return a.is_east ? -1 : 1;
}

async function fetchBanzuke(bashoId: number): Promise<BanzukeEntry[]> {
  const res = await axios.get<BanzukeEntry[]>(
    `${SUMOSTATS_BASE}/banzuke/${bashoId}`,
    { timeout: 15_000 },
  );
  return res.data ?? [];
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

async function searchSumostats(name: string): Promise<string> {
  const query = name.trim();
  const res = await axios.get<{ data: RikishiSumostats[] }>(
    `${SUMOSTATS_BASE}/rikishi`,
    { params: { search: query }, timeout: 10_000 }
  );

  const list = res.data?.data ?? [];
  if (list.length === 0) return `No rikishi found matching **${query}**.`;

  const r = list[0]!;
  const age = r.birth_date
    ? Math.floor((Date.now() - new Date(r.birth_date).getTime()) / 31_557_600_000)
    : null;
  const record = `${r.total_wins}W–${r.total_losses}L${r.total_absents ? `–${r.total_absents}A` : ""}`;

  const lines = [
    `**${r.shikona}** (${r.shikona_kanji})`,
    `• Rank: ${expandRank(r.rank)}`,
    r.highest_rank !== r.rank ? `• Career best: ${expandRank(r.highest_rank)}` : null,
    `• Stable: ${r.heya.name}`,
    `• From: ${r.country}${r.prefecture ? `, ${r.prefecture}` : ""}`,
    `• Height: ${r.height} cm  |  Weight: ${r.weight} kg`,
    age ? `• Age: ${age}` : null,
    `• Record: ${record}`,
    `• ELO: ${Math.round(r.current_elo)}`,
    r.retired_basho ? `• Retired: ${r.retired_basho}` : null,
  ].filter(Boolean);

  return lines.join("\n");
}

async function searchSumoApi(name: string): Promise<string> {
  const query = titleCase(name.trim());
  const res = await axios.get<{ rikishi: RikishiBasic[] }>(
    `${SUMOAPI_BASE}/rikishis`,
    { params: { shikonaEn: query, limit: 5 }, timeout: 10_000 }
  );

  const list = res.data?.rikishi ?? [];
  if (list.length === 0) return `No rikishi found matching **${query}**.`;

  const r = list[0]!;
  const age = r.birthDate
    ? Math.floor((Date.now() - new Date(r.birthDate).getTime()) / 31_557_600_000)
    : null;

  const lines = [
    `**${r.shikonaEn}** (${r.shikonaJp})`,
    `• Rank: ${r.currentRank}`,
    `• Stable: ${r.heya}`,
    `• From: ${r.shusshin}`,
    `• Height: ${r.height} cm  |  Weight: ${r.weight} kg`,
    age ? `• Age: ${age}` : null,
    `• Debut: ${r.debut}`,
  ].filter(Boolean);

  return lines.join("\n");
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function cmdRikishi({ args }: CommandContext): Promise<string | null> {
  const useOfficial = args.includes("--official");
  const nameArgs = args.filter((a) => a !== "--official");
  if (nameArgs.length === 0) {
    return "Usage: `!sumo rikishi <shikona>` — add `--official` to use sumo-api.com (exact match)";
  }
  const name = nameArgs.join(" ");
  return useOfficial ? searchSumoApi(name) : searchSumostats(name);
}

async function cmdFavorite(_ctx: CommandContext, favorite: string): Promise<string | null> {
  if (!favorite) return "No favourite rikishi configured. Set `SUMO_FAVORITE` in `.env`.";
  return searchSumostats(favorite);
}

function cmdBasho(): string {
  const now = new Date();

  // Find current or next basho
  const upcoming = BASHO_SCHEDULE.filter((b) => b.end >= now);
  if (upcoming.length === 0) return "No upcoming basho data available.";

  const lines: string[] = [];

  const current = upcoming.find((b) => b.start <= now && b.end >= now);
  if (current) {
    const day = Math.floor((now.getTime() - current.start.getTime()) / 86_400_000) + 1;
    lines.push(`**Current basho — Day ${day}/15**`);
    lines.push(`📍 ${current.name}`);
    lines.push(`📍 ${current.location}`);
    lines.push(`📅 ${fmt(current.start)} – ${fmt(current.end)}`);
    lines.push("");
  }

  const next = upcoming.find((b) => b.start > now);
  if (next) {
    const daysUntil = Math.ceil((next.start.getTime() - now.getTime()) / 86_400_000);
    lines.push(`**Next basho — in ${daysUntil} day${daysUntil === 1 ? "" : "s"}**`);
    lines.push(`🏆 ${next.name}`);
    lines.push(`📍 ${next.location}`);
    lines.push(`📅 ${fmt(next.start)} – ${fmt(next.end)}`);
  }

  return lines.join("\n");
}

async function cmdToday(): Promise<string> {
  const active = getActiveBasho();
  if (!active) return "No basho is currently running. Use `!sumo basho` for the schedule.";

  const all = await fetchBanzuke(active.id);
  const maku = all.filter((r) => r.division === "Makuuchi");
  if (maku.length === 0) return "Banzuke data not available yet.";

  // Group by wins descending
  const byWins = new Map<number, BanzukeEntry[]>();
  for (const r of maku) {
    if (!byWins.has(r.wins)) byWins.set(r.wins, []);
    byWins.get(r.wins)!.push(r);
  }
  const winGroups = [...byWins.keys()].sort((a, b) => b - a);

  const lines: string[] = [];
  lines.push(`**${active.basho.name} — Day ${active.day}/15**`);
  lines.push(`📍 ${active.basho.location} · ${fmt(active.basho.start)} – ${fmt(active.basho.end)}`);
  lines.push("");

  // Show top 5 win groups (covers most of the interesting standings)
  for (const wins of winGroups.slice(0, 5)) {
    const wrestlers = byWins.get(wins)!.sort(sortBanzukeEntry);
    const names = wrestlers
      .map((r) => `${r.names.shikona} (${r.rank_letter}${r.rank_number}${r.rank_side})`)
      .join(", ");
    const losses = wrestlers[0]!.losses;
    const missStr = wrestlers[0]!.misses ? `+${wrestlers[0]!.misses}A` : "";
    lines.push(`**${wins}–${losses}${missStr}:** ${names}`);
  }

  return lines.join("\n");
}

async function cmdBanzuke(args: string[]): Promise<string> {
  const divArg = (args[0] ?? "").toLowerCase();
  const divMap: Record<string, string> = {
    makuuchi: "Makuuchi", top: "Makuuchi", "": "Makuuchi",
    juryo: "Juryo", j: "Juryo",
    makushita: "Makushita", ms: "Makushita",
    sandanme: "Sandanme", sd: "Sandanme",
    jonidan: "Jonidan", jd: "Jonidan",
    jonokuchi: "Jonokuchi", jo: "Jonokuchi",
  };
  const division = divMap[divArg];
  if (!division) {
    return "Unknown division. Try: `makuuchi`, `juryo`, `makushita`, `sandanme`, `jonidan`, `jonokuchi`.";
  }

  const current = getMostRecentBasho();
  if (!current) return "No basho data available.";

  const all = await fetchBanzuke(current.id);
  const wrestlers = all
    .filter((r) => r.division === division)
    .sort(sortBanzukeEntry);
  if (wrestlers.length === 0) return `No banzuke data for ${division}.`;

  const active = getActiveBasho();
  const dayStr = active ? ` — Day ${active.day}/15` : "";
  const lines: string[] = [];
  lines.push(`**${current.basho.name} — ${division} Banzuke${dayStr}**`);
  lines.push("");

  // Pair east/west entries for display
  const slots = new Map<string, { east?: BanzukeEntry; west?: BanzukeEntry }>();
  for (const r of wrestlers) {
    const key = `${r.rank_letter}${r.rank_number}`;
    if (!slots.has(key)) slots.set(key, {});
    if (r.is_east) slots.get(key)!.east = r;
    else slots.get(key)!.west = r;
  }

  // Build rows: East name + record | RANK | West name + record
  const rows: string[] = [];
  for (const [key, pair] of slots) {
    const eName = pair.east ? `${pair.east.names.shikona} ${pair.east.wins}–${pair.east.losses}` : "";
    const wName = pair.west ? `${pair.west.names.shikona} ${pair.west.wins}–${pair.west.losses}` : "";
    rows.push(`${eName.padEnd(22)} ${key.padEnd(4)} ${wName}`);
  }

  lines.push("```");
  lines.push(`${"East".padEnd(22)} Rank ${"West"}`);
  lines.push("─".repeat(50));
  lines.push(...rows);
  lines.push("```");

  return lines.join("\n");
}

function cmdTerm(args: string[]): string {
  if (args.length === 0) {
    return `Usage: \`!sumo term <word>\`\nKnown terms: ${Object.keys(TERMS).sort().join(", ")}`;
  }
  const key = args.join(" ").toLowerCase();
  const def = TERMS[key];
  return def ? `**${key}**: ${def}` : `Unknown term "${key}". Try \`!sumo term\` for the full list.`;
}

function fmt(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ── Module ────────────────────────────────────────────────────────────────────

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.registerModule('sumo', 'Sumo wrestling — rikishi lookup, basho schedule, live standings');

    const favorite = env("SUMO_FAVORITE", "");

    registry.register({
      name: "sumo",
      module: 'sumo',
      help: "Sumo info — rikishi lookup, basho schedule, live standings, banzuke, rules, terms",
      description: "Look up wrestlers by name, check the current basho schedule, view live standings, browse the banzuke, or look up rules and terms.",
      usage: "rikishi <name> | favorite | basho | today | banzuke [division] | rules | term <word>",
      handler: async (ctx) => {
        const sub = ctx.args[0]?.toLowerCase();
        const rest = ctx.args.slice(1);

        switch (sub) {
          case "rikishi":
            return cmdRikishi({ ...ctx, args: rest });
          case "favorite":
          case "favourite":
            return cmdFavorite(ctx, favorite);
          case "basho":
            return cmdBasho();
          case "today":
          case "standings":
            return cmdToday();
          case "banzuke":
            return cmdBanzuke(rest);
          case "rules":
            return RULES;
          case "term":
            return cmdTerm(rest);
          default:
            return [
              "**!sumo subcommands:**",
              "• `!sumo rikishi <name>` — look up a rikishi (partial match via sumostats.com)",
              "• `!sumo rikishi <name> --official` — exact match via sumo-api.com",
              "• `!sumo favorite` — your configured favourite rikishi",
              "• `!sumo basho` — current/upcoming tournament dates",
              "• `!sumo today` — live standings during an active basho",
              "• `!sumo banzuke [division]` — ranking list (default: Makuuchi)",
              "• `!sumo rules` — basic rules overview",
              "• `!sumo term <word>` — look up a sumo term",
            ].join("\n");
        }
      },
    });

    const fav = favorite ? ` (favourite: ${favorite})` : " (no SUMO_FAVORITE set)";
    log.info(`registered${fav}`);
  },
};

module.exports = mod;
