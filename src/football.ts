/**
 * Module: football
 * Football/soccer match tracking via football-data.org API.
 *
 * Commands:
 *   !football              — Next match or live score for your club
 *   !football score        — Live score + scorers (only when match in progress)
 *   !football table        — League standings (centred around your club)
 *   !football fixtures [n] — Upcoming fixtures (default: 5)
 *
 * Push notifications (live match monitor):
 *   Posts to FOOTBALL_LIVE_ROOMS on: kickoff, every goal, half-time, full-time.
 *   Polling is adaptive: idle → pre-match → live.
 *
 * Configuration via .env:
 *   FOOTBALL_API_KEY=abc123            — football-data.org free API key (required)
 *   FOOTBALL_CLUB_ID=57                — Club numeric ID (required; e.g. Arsenal = 57)
 *   FOOTBALL_COMPETITION=PL            — Competition code for !football table (default: PL)
 *   FOOTBALL_LIVE_ROOMS=!room:server   — Rooms for push notifications (comma-separated)
 *   FOOTBALL_IDLE_INTERVAL=300         — Poll interval (sec) when no match today (default: 300)
 *   FOOTBALL_PREMATCH_INTERVAL=60      — Poll interval (sec) within 30 min of kickoff (default: 60)
 *   FOOTBALL_LIVE_INTERVAL=30          — Poll interval (sec) during live match (default: 30)
 *
 * Data source: https://football-data.org (free tier: 10 req/min)
 * Club IDs:   https://www.football-data.org/v4/teams
 */

import axios from "axios";
import { MatrixClient, MsgType } from "matrix-js-sdk";
import { BotModule, ModuleRegistry, CommandContext, renderHtml, errMsg } from "lumi";
import { BotConfig, env, envInt, envList } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger("football");

const BASE = "https://api.football-data.org/v4";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Team {
  id: number;
  name: string;
  shortName: string;
  tla: string;
}

interface Score {
  winner: string | null;
  duration: string;
  fullTime: { home: number | null; away: number | null };
  halfTime: { home: number | null; away: number | null };
}

interface Goal {
  minute: number;
  team: { id: number; name: string };
  scorer: { name: string };
  type: string;
}

interface Match {
  id: number;
  competition: { id: number; name: string; code: string };
  homeTeam: Team;
  awayTeam: Team;
  utcDate: string;
  /** SCHEDULED | TIMED | IN_PLAY | PAUSED | FINISHED | SUSPENDED | POSTPONED | CANCELLED */
  status: string;
  minute?: number;
  score: Score;
  goals?: Goal[];
}

interface StandingRow {
  position: number;
  team: Team;
  playedGames: number;
  points: number;
  won: number;
  draw: number;
  lost: number;
  goalDifference: number;
}

// ── API helpers ───────────────────────────────────────────────────────────────

function headers(apiKey: string) {
  return { "X-Auth-Token": apiKey };
}

async function fetchMatchesByStatus(
  clubId: number,
  apiKey: string,
  statuses: string[],
  limit = 5,
): Promise<Match[]> {
  const res = await axios.get<{ matches: Match[] }>(
    `${BASE}/teams/${clubId}/matches`,
    {
      headers: headers(apiKey),
      params: { status: statuses.join(","), limit },
      timeout: 10_000,
    },
  );
  return res.data.matches ?? [];
}

async function fetchMatchById(matchId: number, apiKey: string): Promise<Match> {
  const res = await axios.get<Match>(`${BASE}/matches/${matchId}`, {
    headers: headers(apiKey),
    timeout: 10_000,
  });
  return res.data;
}

async function fetchFixtures(
  clubId: number,
  apiKey: string,
  count: number,
): Promise<Match[]> {
  const dateFrom = new Date().toISOString().slice(0, 10);
  const dateTo = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  const res = await axios.get<{ matches: Match[] }>(
    `${BASE}/teams/${clubId}/matches`,
    {
      headers: headers(apiKey),
      params: { dateFrom, dateTo, status: "SCHEDULED,TIMED", limit: count },
      timeout: 10_000,
    },
  );
  return res.data.matches ?? [];
}

async function fetchStandings(
  competition: string,
  apiKey: string,
): Promise<StandingRow[]> {
  const res = await axios.get<{ standings: Array<{ type: string; table: StandingRow[] }> }>(
    `${BASE}/competitions/${competition}/standings`,
    { headers: headers(apiKey), timeout: 10_000 },
  );
  return res.data.standings.find((s) => s.type === "TOTAL")?.table ?? [];
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtDate(utcDate: string): string {
  return new Date(utcDate).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }) + " UTC";
}

function fmtScore(m: Match): string {
  const h = m.score.fullTime.home ?? 0;
  const a = m.score.fullTime.away ?? 0;
  return `${m.homeTeam.shortName} ${h}–${a} ${m.awayTeam.shortName}`;
}

function liveMinute(m: Match): string {
  if (m.status === "PAUSED") return "HT";
  return m.minute != null ? `${m.minute}'` : "";
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function cmdMatch(clubId: number, apiKey: string): Promise<string> {
  const live = await fetchMatchesByStatus(clubId, apiKey, ["IN_PLAY", "PAUSED"], 1);
  if (live.length > 0) {
    const m = live[0]!;
    const min = liveMinute(m);
    return `**LIVE${min ? ` (${min})` : ""}** — ${fmtScore(m)}`;
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayMatches = await fetchMatchesByStatus(
    clubId,
    apiKey,
    ["SCHEDULED", "TIMED", "FINISHED"],
    3,
  );
  const todayMatch = todayMatches.find((m) => m.utcDate.startsWith(today));
  if (todayMatch) {
    if (todayMatch.status === "FINISHED") {
      return `**FT:** ${fmtScore(todayMatch)}`;
    }
    const minsToKickoff = Math.round(
      (new Date(todayMatch.utcDate).getTime() - Date.now()) / 60_000,
    );
    return [
      `**Today:** ${todayMatch.homeTeam.shortName} vs ${todayMatch.awayTeam.shortName}`,
      `• ${todayMatch.competition.name}`,
      `• Kickoff: ${fmtDate(todayMatch.utcDate)} (in ${minsToKickoff} min)`,
    ].join("\n");
  }

  const fixtures = await fetchFixtures(clubId, apiKey, 1);
  if (fixtures.length === 0) return "No upcoming fixtures found.";
  const next = fixtures[0]!;
  return [
    `**Next:** ${next.homeTeam.shortName} vs ${next.awayTeam.shortName}`,
    `• ${next.competition.name}`,
    `• ${fmtDate(next.utcDate)}`,
  ].join("\n");
}

async function cmdScore(clubId: number, apiKey: string): Promise<string> {
  const live = await fetchMatchesByStatus(clubId, apiKey, ["IN_PLAY", "PAUSED"], 1);
  if (live.length === 0) return "No live match in progress.";

  const m = await fetchMatchById(live[0]!.id, apiKey);
  const min = liveMinute(m);
  const lines = [`**LIVE${min ? ` (${min})` : ""}** — ${fmtScore(m)}`];

  if (m.goals && m.goals.length > 0) {
    lines.push("");
    for (const g of m.goals) {
      const forUs = g.team.id === clubId;
      lines.push(`${forUs ? "⚽" : "  "} ${g.scorer.name} (${g.minute}') — ${g.team.name}`);
    }
  }
  return lines.join("\n");
}

async function cmdTable(
  competition: string,
  clubId: number,
  apiKey: string,
): Promise<string> {
  const table = await fetchStandings(competition, apiKey);
  if (table.length === 0) return "No standings data found.";

  const clubIdx = table.findIndex((r) => r.team.id === clubId);
  const start = Math.max(0, clubIdx >= 0 ? clubIdx - 4 : 0);
  const rows = table.slice(start, Math.min(table.length, start + 10));

  const lines = [`**${competition} Standings:**\n`];
  for (const r of rows) {
    const gd = r.goalDifference >= 0 ? `+${r.goalDifference}` : `${r.goalDifference}`;
    const mark = r.team.id === clubId ? "**" : "";
    lines.push(
      `${mark}${r.position}. ${r.team.shortName.padEnd(12)} ${String(r.points).padStart(3)}pts  ${r.won}W ${r.draw}D ${r.lost}L  GD${gd}${mark}`,
    );
  }
  return lines.join("\n");
}

async function cmdFixtures(
  clubId: number,
  apiKey: string,
  count: number,
): Promise<string> {
  const matches = await fetchFixtures(clubId, apiKey, count);
  if (matches.length === 0) return "No upcoming fixtures found.";

  const lines = ["**Upcoming fixtures:**\n"];
  for (const m of matches) {
    lines.push(
      `• ${fmtDate(m.utcDate)} — ${m.homeTeam.shortName} vs ${m.awayTeam.shortName} (${m.competition.name})`,
    );
  }
  return lines.join("\n");
}

// ── Live match monitor ────────────────────────────────────────────────────────

interface LiveState {
  matchId: number | null;
  goalCount: number;
  postedKickoff: boolean;
  postedHalftime: boolean;
  postedFullTime: boolean;
}

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

function startLiveMonitor(
  client: MatrixClient,
  rooms: string[],
  clubId: number,
  apiKey: string,
  intervals: { idle: number; prematch: number; live: number },
): void {
  const state: LiveState = {
    matchId: null,
    goalCount: 0,
    postedKickoff: false,
    postedHalftime: false,
    postedFullTime: false,
  };

  function resetState(matchId: number): void {
    state.matchId = matchId;
    state.goalCount = 0;
    state.postedKickoff = false;
    state.postedHalftime = false;
    state.postedFullTime = false;
  }

  async function tick(): Promise<void> {
    let nextDelay = intervals.idle * 1_000;
    try {
      const liveMatches = await fetchMatchesByStatus(
        clubId,
        apiKey,
        ["IN_PLAY", "PAUSED"],
        1,
      );

      if (liveMatches.length > 0) {
        // ── Live path ────────────────────────────────────────────────────────
        nextDelay = intervals.live * 1_000;
        const summary = liveMatches[0]!;

        if (summary.id !== state.matchId) resetState(summary.id);

        // Fetch full match detail for goals array
        const m = await fetchMatchById(summary.id, apiKey);

        if (!state.postedKickoff) {
          state.postedKickoff = true;
          const venue = m.homeTeam.id === clubId ? "home" : "away";
          await sendToRooms(
            client,
            rooms,
            `**Kickoff!** ${m.homeTeam.shortName} vs ${m.awayTeam.shortName} — ${m.competition.name} (${venue})`,
          );
        }

        const goals = m.goals ?? [];
        if (goals.length > state.goalCount) {
          for (const g of goals.slice(state.goalCount)) {
            const forUs = g.team.id === clubId;
            const h = m.score.fullTime.home ?? 0;
            const a = m.score.fullTime.away ?? 0;
            await sendToRooms(
              client,
              rooms,
              `${forUs ? "⚽" : "😬"} **Goal! ${g.scorer.name}** (${g.minute}') — ${m.homeTeam.shortName} ${h}–${a} ${m.awayTeam.shortName}`,
            );
          }
          state.goalCount = goals.length;
        }

        if (m.status === "PAUSED" && !state.postedHalftime) {
          state.postedHalftime = true;
          const ht = m.score.halfTime;
          await sendToRooms(
            client,
            rooms,
            `**Half-time:** ${m.homeTeam.shortName} ${ht.home ?? 0}–${ht.away ?? 0} ${m.awayTeam.shortName}`,
          );
        }
      } else {
        // ── No live match — check today's schedule ────────────────────────
        const today = new Date().toISOString().slice(0, 10);
        const todayMatches = await fetchMatchesByStatus(
          clubId,
          apiKey,
          ["SCHEDULED", "TIMED", "FINISHED"],
          3,
        );
        const todayMatch = todayMatches.find((m) => m.utcDate.startsWith(today));

        if (todayMatch) {
          if (todayMatch.id !== state.matchId) resetState(todayMatch.id);

          if (todayMatch.status === "FINISHED" && !state.postedFullTime) {
            state.postedFullTime = true;
            const h = todayMatch.score.fullTime.home ?? 0;
            const a = todayMatch.score.fullTime.away ?? 0;
            const ourGoals = todayMatch.homeTeam.id === clubId ? h : a;
            const theirGoals = todayMatch.homeTeam.id === clubId ? a : h;
            const result =
              ourGoals > theirGoals ? "Win" : ourGoals < theirGoals ? "Loss" : "Draw";
            await sendToRooms(
              client,
              rooms,
              `**FT: ${fmtScore(todayMatch)}** — ${result}`,
            );
          } else if (todayMatch.status !== "FINISHED") {
            const minsToKickoff =
              (new Date(todayMatch.utcDate).getTime() - Date.now()) / 60_000;
            nextDelay =
              (minsToKickoff <= 30 ? intervals.prematch : intervals.idle) * 1_000;
          }
        }
      }
    } catch (err) {
      log.error("live monitor error:", errMsg(err));
    }
    setTimeout(tick, nextDelay);
  }

  // Small startup delay to let the Matrix client finish syncing
  setTimeout(tick, 5_000);
  log.info(
    `live monitor armed (idle=${intervals.idle}s prematch=${intervals.prematch}s live=${intervals.live}s) → ${rooms.length} room(s)`,
  );
}

// ── Module ────────────────────────────────────────────────────────────────────

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.registerModule('football', 'Football match scores and fixtures for your club');

    const apiKey = env("FOOTBALL_API_KEY");
    const clubId = envInt("FOOTBALL_CLUB_ID", 0);

    if (!apiKey || !clubId) {
      log.info("disabled — set FOOTBALL_API_KEY and FOOTBALL_CLUB_ID to enable");
      return;
    }

    const competition = env("FOOTBALL_COMPETITION", "PL");
    const liveRooms = envList("FOOTBALL_LIVE_ROOMS");
    const idleInterval = envInt("FOOTBALL_IDLE_INTERVAL", 300);
    const prematchInterval = envInt("FOOTBALL_PREMATCH_INTERVAL", 60);
    const liveInterval = envInt("FOOTBALL_LIVE_INTERVAL", 30);

    registry.register({
      name: "football",
      module: 'football',
      help: "Football match info for your club",
      description: "Shows live score, league table position, or upcoming fixtures. Configure your club via FOOTBALL_CLUB_ID.",
      usage: "[score | table | fixtures [n]]",
      handler: async (ctx: CommandContext) => {
        const sub = ctx.args[0]?.toLowerCase();
        const n = parseInt(ctx.args[1] ?? "5", 10);

        try {
          switch (sub) {
            case "score":
              return cmdScore(clubId, apiKey);
            case "table":
              return cmdTable(competition, clubId, apiKey);
            case "fixtures":
              return cmdFixtures(clubId, apiKey, Number.isNaN(n) ? 5 : Math.min(n, 10));
            default:
              return cmdMatch(clubId, apiKey);
          }
        } catch (err) {
          return `❌ Football API error: ${errMsg(err)}`;
        }
      },
    });

    if (liveRooms.length > 0) {
      registry.onStart(async (client) => {
        startLiveMonitor(client, liveRooms, clubId, apiKey, {
          idle: idleInterval,
          prematch: prematchInterval,
          live: liveInterval,
        });
      });
      log.info(`registered — club ${clubId}, competition ${competition}, live monitor → ${liveRooms.length} room(s)`);
    } else {
      log.info(`registered — club ${clubId}, competition ${competition} (no FOOTBALL_LIVE_ROOMS, live monitor disabled)`);
    }
  },
};

module.exports = mod;
