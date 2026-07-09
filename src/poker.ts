import { MatrixClient, MatrixEvent, MatrixEventEvent, MsgType, RoomEvent } from "matrix-js-sdk";
import { BotModule, ModuleRegistry, errMsg } from "lumi";
import { BotConfig, envInt, envList } from "lumi";
import { logger } from "lumi";

const log = logger.getLogger('poker');

const POLL_RESPONSE_TYPES = ["org.matrix.msc3381.poll.response", "m.poll.response"];

// ── Types ─────────────────────────────────────────────────────────────────────

export type EligibleMember = { userId: string; displayName: string };

type HistoryEntry = { story: string; score: string | null };

type SessionBase = {
  roomId: string; story: string; jiraUrl?: string; initiator: string;
  history: HistoryEntry[];
};

type AwaitingAmSession           = SessionBase & { phase: "awaiting_am" };
type AwaitingParticipantsSession = SessionBase & {
  phase: "awaiting_participants";
  am: string;
  eligible: EligibleMember[];
  selectionPollEventId: string;
  amSelection: string[];
};
type PollingSession              = SessionBase & {
  phase: "polling";
  pollEventId: string;
  revealMsgId: string;
  am: string;
  allowedVoters: Set<string>;
  voterMembers: EligibleMember[];
  voters: Set<string>;
  votes: Map<string, string>;
  timeoutHandle?: ReturnType<typeof setTimeout>;
};
type AwaitingNextStorySession    = SessionBase & {
  phase: "awaiting_next_story";
  am: string;
  voterMembers: EligibleMember[];
};

type PokerSession = AwaitingAmSession | AwaitingParticipantsSession | PollingSession | AwaitingNextStorySession;

// ── Constants ─────────────────────────────────────────────────────────────────

const FIBONACCI_ANSWERS = [
  { id: "1",  "org.matrix.msc1767.text": "1" },
  { id: "2",  "org.matrix.msc1767.text": "2" },
  { id: "3",  "org.matrix.msc1767.text": "3" },
  { id: "5",  "org.matrix.msc1767.text": "5" },
  { id: "8",  "org.matrix.msc1767.text": "8" },
  { id: "13", "org.matrix.msc1767.text": "13" },
  { id: "c",  "org.matrix.msc1767.text": "☕" },
];

const AM_KEYWORD_RE = /\bi(?:'m| am) the (?:agile master|am)\b/i;

// ── Pure helpers (exported for tests) ────────────────────────────────────────

export function getEligibleMembers(
  client: MatrixClient,
  roomId: string,
  excludeUserIds: string[],
): EligibleMember[] {
  const room = client.getRoom(roomId);
  if (!room) return [];
  return room
    .getMembers()
    .filter((m) => m.membership === "join" && !excludeUserIds.includes(m.userId))
    .map((m) => ({ userId: m.userId, displayName: m.name || m.userId }));
}

export function parseParticipants(
  input: string,
  eligible: EligibleMember[],
): { selected: EligibleMember[]; unknown: string[] } {
  if (input.trim().toLowerCase() === "all") return { selected: eligible, unknown: [] };

  const names = input.trim().split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  const selected: EligibleMember[] = [];
  const unknown: string[] = [];

  for (const name of names) {
    const lname = name.toLowerCase();
    const match = eligible.find(
      (m) =>
        m.displayName.toLowerCase() === lname ||
        m.displayName.toLowerCase().startsWith(lname) ||
        m.userId.split(":")[0]?.slice(1).toLowerCase() === lname,
    );
    if (match && !selected.some((s) => s.userId === match.userId)) {
      selected.push(match);
    } else if (!match) {
      unknown.push(name);
    }
  }

  return { selected, unknown };
}

// ── Module ────────────────────────────────────────────────────────────────────

function isMod(client: MatrixClient, roomId: string, userId: string): boolean {
  return (client.getRoom(roomId)?.getMember(userId)?.powerLevel ?? 0) >= 50;
}

function revealText(session: PollingSession): string {
  const jira = session.jiraUrl ? ` — ${session.jiraUrl}` : "";
  const waiting = session.voterMembers
    .filter((m) => !session.voters.has(m.userId))
    .map((m) => m.displayName);
  const waitingStr = waiting.length ? ` · Waiting on: ${waiting.join(", ")}` : "";
  return (
    `React 🏁 to reveal votes | React ♻️ to vote again | React ⏭️ to skip${jira}` +
    ` — ${session.voters.size}/${session.allowedVoters.size} voted${waitingStr}`
  );
}

function consensusLine(votes: Map<string, string>): string {
  if (votes.size === 0) return "";
  const ids = FIBONACCI_ANSWERS.map((a) => a.id);
  const unique = [...new Set(votes.values())];
  if (unique.length === 1) {
    const label = FIBONACCI_ANSWERS.find((a) => a.id === unique[0])?.["org.matrix.msc1767.text"] ?? unique[0];
    return `✅ Consensus: ${label}`;
  }
  const indices = unique.map((id) => ids.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
  const iFirst = indices[0] ?? -1;
  const iLast  = indices[indices.length - 1] ?? -1;
  if (indices.length >= 2 && iLast - iFirst <= 1) {
    const lo = FIBONACCI_ANSWERS[iFirst]?.["org.matrix.msc1767.text"] ?? "";
    const hi = FIBONACCI_ANSWERS[iLast]?.["org.matrix.msc1767.text"] ?? "";
    return `~Rough consensus: ${lo}–${hi}`;
  }
  const scored = unique.filter((id) => id !== "c");
  const scoredIdx = scored.map((id) => ids.indexOf(id)).filter((i) => i >= 0).sort((a, b) => a - b);
  const sFirst = scoredIdx[0] ?? -1;
  const sLast  = scoredIdx[scoredIdx.length - 1] ?? -1;
  if (scoredIdx.length >= 2 && sFirst >= 0 && sLast >= 0) {
    const lo = FIBONACCI_ANSWERS[sFirst]?.["org.matrix.msc1767.text"] ?? "";
    const hi = FIBONACCI_ANSWERS[sLast]?.["org.matrix.msc1767.text"] ?? "";
    return `⚠️ Spread: ${lo}–${hi} — discuss!`;
  }
  return "";
}

function buildStatsMessage(session: PollingSession): string {
  const total = session.voters.size;
  const header = `📊 ${session.story} — ${total}/${session.allowedVoters.size} voted`;
  if (total === 0) return header;

  const counts = new Map<string, number>();
  for (const answerId of session.votes.values()) {
    counts.set(answerId, (counts.get(answerId) ?? 0) + 1);
  }

  const maxCount = Math.max(...counts.values());
  const BAR_WIDTH = 8;
  const lines: string[] = [header];

  for (const answer of FIBONACCI_ANSWERS) {
    const count = counts.get(answer.id) ?? 0;
    if (count === 0) continue;
    const bars = Math.max(1, Math.round((count / maxCount) * BAR_WIDTH));
    const bar = "█".repeat(bars);
    const pct = Math.round((count / total) * 100);
    const label = answer["org.matrix.msc1767.text"].padEnd(3);
    lines.push(`${label}${bar} ${count} (${pct}%)`);
  }

  const noVote = session.voterMembers.filter((m) => !session.voters.has(m.userId));
  if (noVote.length > 0) {
    lines.push(`No vote from: ${noVote.map((m) => m.displayName).join(", ")}`);
  }

  const cl = consensusLine(session.votes);
  if (cl) lines.push(cl);

  return lines.join("\n");
}

function consensusScore(session: PollingSession): string | null {
  if (session.votes.size === 0) return null;
  const counts = new Map<string, number>();
  for (const v of session.votes.values()) counts.set(v, (counts.get(v) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return FIBONACCI_ANSWERS.map((a) => a.id).find((id) => (counts.get(id) ?? 0) === max) ?? null;
}

function buildSummaryMessage(history: HistoryEntry[]): string {
  if (history.length === 0) return "";

  const scored  = history.filter((h) => h.score !== null);
  const skipped = history.filter((h) => h.score === null);
  const skippedNote = skipped.length > 0 ? ` (${skipped.length} skipped)` : "";
  const header = `📋 Refinement complete — ${history.length} stor${history.length === 1 ? "y" : "ies"}${skippedNote}`;
  const lines: string[] = [header];

  if (scored.length > 0) {
    const counts = new Map<string, number>();
    for (const h of scored) counts.set(h.score!, (counts.get(h.score!) ?? 0) + 1);
    const maxCount = Math.max(...counts.values());
    const BAR_WIDTH = 8;
    for (const answer of FIBONACCI_ANSWERS) {
      const count = counts.get(answer.id) ?? 0;
      if (count === 0) continue;
      const bars = Math.max(1, Math.round((count / maxCount) * BAR_WIDTH));
      const bar = "█".repeat(bars);
      const label = answer["org.matrix.msc1767.text"].padEnd(3);
      lines.push(`${label}${bar} ${count} stor${count === 1 ? "y" : "ies"}`);
    }
  }

  return lines.join("\n");
}

function resolveVoter(query: string, pool: EligibleMember[]): EligibleMember | undefined {
  const lq = query.toLowerCase();
  return pool.find(
    (m) =>
      m.userId === query ||
      m.userId === `@${query}` ||
      m.userId.split(":")[0]?.slice(1).toLowerCase() === lq ||
      m.displayName.toLowerCase() === lq ||
      m.displayName.toLowerCase().startsWith(lq),
  );
}

const mod: BotModule = {
  register(registry: ModuleRegistry, _config: BotConfig) {
    registry.registerModule("poker", "Interactive planning poker via Matrix polls");

    const pokerRooms   = envList("POKER_ROOMS");
    const jiraBase     = process.env.POKER_JIRA_BASE ?? "";
    const timeoutMins  = envInt("POKER_TIMEOUT_MINS", 0);
    const cooldownSecs = envInt("POKER_COOLDOWN_SECS", 0);
    const autoReveal   = process.env.POKER_AUTO_REVEAL !== "false";

    const sessions  = new Map<string, PokerSession>();
    const cooldowns = new Map<string, number>();

    // ── Helpers ───────────────────────────────────────────────────────────────

    async function postSummary(client: MatrixClient, roomId: string, history: HistoryEntry[]): Promise<void> {
      const msg = buildSummaryMessage(history);
      if (!msg) return;
      try {
        await client.sendMessage(roomId, { msgtype: MsgType.Text, body: msg });
      } catch (err) {
        log.error("failed to send session summary:", errMsg(err));
      }
    }

    async function claimAM(
      client: MatrixClient,
      roomId: string,
      session: AwaitingAmSession,
      am: string,
    ): Promise<void> {
      const eligible = getEligibleMembers(client, roomId, [am, client.getUserId()!]);

      if (eligible.length === 0) {
        sessions.delete(roomId);
        await client.sendMessage(roomId, {
          msgtype: MsgType.Text,
          body: "No eligible voters in this room. Session cancelled.",
        });
        return;
      }

      let selectionPollEventId: string;
      try {
        const res = await (client as any).sendEvent(roomId, "org.matrix.msc3381.poll.start", {
          "org.matrix.msc3381.poll.start": {
            question: { "org.matrix.msc1767.text": "Who should vote?" },
            kind: "org.matrix.msc3381.poll.disclosed",
            max_selections: eligible.length,
            answers: eligible.map((m) => ({ id: m.userId, "org.matrix.msc1767.text": m.displayName })),
          },
          "org.matrix.msc1767.text": "Who should vote?",
        });
        selectionPollEventId = res.event_id;
      } catch (err) {
        log.error("failed to send selection poll:", errMsg(err));
        sessions.delete(roomId);
        return;
      }

      try {
        await client.sendMessage(roomId, {
          msgtype: MsgType.Text,
          body: `${am} is the Agile Master! Vote to select participants, then react ✅ or \`!AM\` to start.`,
        });
      } catch (err) {
        log.error("failed to send confirm message:", errMsg(err));
        sessions.delete(roomId);
        return;
      }

      sessions.set(roomId, {
        phase: "awaiting_participants",
        roomId: session.roomId,
        story: session.story,
        jiraUrl: session.jiraUrl,
        initiator: session.initiator,
        history: session.history,
        am,
        eligible,
        selectionPollEventId,
        amSelection: [],
      });
    }

    async function closeSelectionAndStart(
      client: MatrixClient,
      session: AwaitingParticipantsSession,
      selected: EligibleMember[],
    ): Promise<void> {
      try {
        await (client as any).sendEvent(session.roomId, "org.matrix.msc3381.poll.end", {
          "m.relates_to": { rel_type: "m.reference", event_id: session.selectionPollEventId },
          "org.matrix.msc3381.poll.end": {},
          "org.matrix.msc1767.text": "Participant selection complete.",
        });
      } catch (err) {
        log.error("failed to close selection poll:", errMsg(err));
      }
      await startPolling(client, session, selected);
    }

    async function endPoll(
      client: MatrixClient,
      session: PollingSession,
      silent = false,
      endRefinement = false,
    ): Promise<void> {
      clearTimeout(session.timeoutHandle);

      try {
        await (client as any).sendEvent(session.roomId, "org.matrix.msc3381.poll.end", {
          "m.relates_to": { rel_type: "m.reference", event_id: session.pollEventId },
          "org.matrix.msc3381.poll.end": {},
          "org.matrix.msc1767.text": "Poll ended.",
        });
      } catch (err) {
        log.error("failed to send poll.end:", errMsg(err));
      }

      try {
        await client.sendMessage(session.roomId, {
          msgtype: MsgType.Text,
          body: buildStatsMessage(session),
        });
      } catch (err) {
        log.error("failed to send stats:", errMsg(err));
      }

      const score = consensusScore(session);

      if (endRefinement) {
        const fullHistory = [...session.history, { story: session.story, score }];
        await postSummary(client, session.roomId, fullHistory);
        sessions.delete(session.roomId);
        if (cooldownSecs > 0) cooldowns.set(session.roomId, Date.now() + cooldownSecs * 1000);
        if (!silent) log.info(`refinement ended in ${session.roomId}: "${session.story}"`);
      } else {
        sessions.set(session.roomId, {
          phase: "awaiting_next_story",
          roomId: session.roomId,
          story: session.story,
          jiraUrl: session.jiraUrl,
          initiator: session.initiator,
          am: session.am,
          voterMembers: session.voterMembers,
          history: [...session.history, { story: session.story, score }],
        });
        try {
          await client.sendMessage(session.roomId, {
            msgtype: MsgType.Text,
            body: `Poll closed for "${session.story}".\nNext story: \`!poker next <story>\` — Finish: \`!poker end\``,
          });
        } catch (err) {
          log.error("failed to send continuation prompt:", errMsg(err));
        }
        if (!silent) log.info(`poll ended in ${session.roomId}: "${session.story}"`);
      }
    }

    async function skipPoll(client: MatrixClient, session: PollingSession): Promise<void> {
      clearTimeout(session.timeoutHandle);
      try {
        await (client as any).sendEvent(session.roomId, "org.matrix.msc3381.poll.end", {
          "m.relates_to": { rel_type: "m.reference", event_id: session.pollEventId },
          "org.matrix.msc3381.poll.end": {},
          "org.matrix.msc1767.text": "Story skipped.",
        });
      } catch (err) {
        log.error("failed to close poll for skip:", errMsg(err));
      }
      sessions.set(session.roomId, {
        phase: "awaiting_next_story",
        roomId: session.roomId,
        story: session.story,
        jiraUrl: session.jiraUrl,
        initiator: session.initiator,
        am: session.am,
        voterMembers: session.voterMembers,
        history: [...session.history, { story: session.story, score: null }],
      });
      try {
        await client.sendMessage(session.roomId, {
          msgtype: MsgType.Text,
          body: `Story skipped: "${session.story}".\nNext story: \`!poker next <story>\` — Finish: \`!poker end\``,
        });
      } catch (err) {
        log.error("failed to send skip message:", errMsg(err));
      }
    }

    async function revotePoll(client: MatrixClient, session: PollingSession): Promise<void> {
      clearTimeout(session.timeoutHandle);
      try {
        await (client as any).sendEvent(session.roomId, "org.matrix.msc3381.poll.end", {
          "m.relates_to": { rel_type: "m.reference", event_id: session.pollEventId },
          "org.matrix.msc3381.poll.end": {},
          "org.matrix.msc1767.text": "Poll restarted for revote.",
        });
      } catch (err) {
        log.error("failed to close poll for revote:", errMsg(err));
      }
      await startPolling(client, session, session.voterMembers);
    }

    async function updateVoteCount(client: MatrixClient, session: PollingSession): Promise<void> {
      try {
        const text = revealText(session);
        await client.sendMessage(session.roomId, {
          msgtype: MsgType.Text,
          body: `* ${text}`,
          "m.relates_to": { rel_type: "m.replace", event_id: session.revealMsgId },
          "m.new_content": { msgtype: MsgType.Text, body: text },
        } as any);
      } catch (err) {
        log.error("failed to update vote count:", errMsg(err));
      }
    }

    async function startPolling(
      client: MatrixClient,
      base: { roomId: string; story: string; jiraUrl?: string; initiator: string; am: string; history: HistoryEntry[] },
      voters: EligibleMember[],
    ): Promise<void> {
      const storyText = base.jiraUrl ? `${base.story} — ${base.jiraUrl}` : base.story;

      let pollEventId: string;
      try {
        const res = await (client as any).sendEvent(base.roomId, "org.matrix.msc3381.poll.start", {
          "org.matrix.msc3381.poll.start": {
            question: { "org.matrix.msc1767.text": storyText },
            kind: "org.matrix.msc3381.poll.undisclosed",
            max_selections: 1,
            answers: FIBONACCI_ANSWERS,
          },
          "org.matrix.msc1767.text": storyText,
        });
        pollEventId = res.event_id;
      } catch (err) {
        log.error("failed to send poll.start:", errMsg(err));
        sessions.delete(base.roomId);
        await client.sendMessage(base.roomId, { msgtype: MsgType.Text, body: "Failed to create poll." });
        return;
      }

      const allowedVoters = new Set(voters.map((m) => m.userId));
      const draft: PollingSession = {
        phase: "polling",
        roomId: base.roomId,
        story: base.story,
        jiraUrl: base.jiraUrl,
        initiator: base.initiator,
        am: base.am,
        history: base.history,
        pollEventId,
        revealMsgId: "",
        allowedVoters,
        voterMembers: [...voters],
        voters: new Set(),
        votes: new Map(),
      };

      const initialText = revealText(draft);
      let revealMsgId: string;
      try {
        const res2 = await client.sendMessage(base.roomId, { msgtype: MsgType.Text, body: initialText });
        revealMsgId = (res2 as any).event_id;
      } catch (err) {
        log.error("failed to send reveal message:", errMsg(err));
        sessions.delete(base.roomId);
        return;
      }

      const session: PollingSession = { ...draft, revealMsgId };

      if (timeoutMins > 0) {
        session.timeoutHandle = setTimeout(() => {
          log.info(`poll timed out in ${base.roomId}: "${base.story}"`);
          endPoll(client, session, true, true);
        }, timeoutMins * 60_000);
      }

      sessions.set(base.roomId, session);
      log.info(`poll started in ${base.roomId}: "${base.story}" — ${voters.length} voter(s)`);
    }

    // ── onStart: Timeline listener ────────────────────────────────────────────

    registry.onStart((client: MatrixClient) => {
      const processEvent = async (event: MatrixEvent): Promise<void> => {
        if (event.isRedacted()) return;
        if (event.isDecryptionFailure()) {
          log.warn(`decryption failure for event ${event.getId()} in ${event.getRoomId()}`);
          return;
        }

        const type        = event.getType();
        const sender      = event.getSender();
        const eventRoomId = event.getRoomId();
        if (!sender || !eventRoomId || sender === client.getUserId()) return;

        const session = sessions.get(eventRoomId);
        if (!session) return;

        // ── Awaiting AM ───────────────────────────────────────────────────────
        if (session.phase === "awaiting_am" && type === "m.room.message") {
          const content = event.getContent();
          if ((content["m.relates_to"] as any)?.rel_type === "m.reply") return;
          const body = (content.body ?? "") as string;
          if (!AM_KEYWORD_RE.test(body)) return;
          await claimAM(client, eventRoomId, session, sender);
          return;
        }

        // ── Awaiting participants ─────────────────────────────────────────────
        if (session.phase === "awaiting_participants") {
          if (POLL_RESPONSE_TYPES.includes(type)) {
            const content = event.getContent();
            const rel = content["m.relates_to"] as any;
            if (!rel?.event_id || rel.event_id !== session.selectionPollEventId) return;
            if (sender !== session.am) return;
            const answers: string[] =
              (content["org.matrix.msc3381.poll.response"] as any)?.answers ??
              (content["m.poll.response"] as any)?.answers ?? [];
            session.amSelection = answers;
            return;
          }

          if (type === "m.reaction") {
            const rel = event.getContent()["m.relates_to"] as any;
            if (!rel || rel.rel_type !== "m.annotation" || rel.key?.replace(/️/g, "") !== "✅") return;
            if (sender !== session.am && !isMod(client, eventRoomId, sender)) return;
            const selected = session.eligible.filter((m) => session.amSelection.includes(m.userId));
            if (selected.length === 0) {
              await client.sendMessage(eventRoomId, {
                msgtype: MsgType.Text,
                body: "No participants selected. Vote in the selection poll above, then react ✅ again.",
              });
              return;
            }
            await closeSelectionAndStart(client, session, selected);
            return;
          }

          return;
        }

        // ── Awaiting next story ───────────────────────────────────────────────
        if (session.phase === "awaiting_next_story") {
          if (type === "m.reaction") {
            const rel = event.getContent()["m.relates_to"] as any;
            if (!rel || rel.rel_type !== "m.annotation") return;
            const key = (rel.key ?? "").replace(/️/g, "");
            if (key !== "♻") return;
            if (sender !== session.am && !isMod(client, eventRoomId, sender)) return;
            await startPolling(client, session, session.voterMembers);
          }
          return;
        }

        // ── Polling ───────────────────────────────────────────────────────────
        if (session.phase !== "polling") return;

        if (type === "m.reaction") {
          const rel = event.getContent()["m.relates_to"] as any;
          if (!rel || rel.rel_type !== "m.annotation") return;
          if (rel.event_id !== session.revealMsgId) return;
          if (sender !== session.am && !isMod(client, eventRoomId, sender)) return;
          const key = (rel.key ?? "").replace(/️/g, "");
          if (key === "🏁") { await endPoll(client, session); return; }
          if (key === "♻") { await revotePoll(client, session); return; }
          if (key === "⏭") { await skipPoll(client, session); return; }
          return;
        }

        if (POLL_RESPONSE_TYPES.includes(type)) {
          const rel = event.getContent()["m.relates_to"] as any;
          if (!rel?.event_id || rel.event_id !== session.pollEventId) return;
          if (sender === session.am || !session.allowedVoters.has(sender)) return;
          session.voters.add(sender);
          const content = event.getContent();
          const answerId =
            (content["org.matrix.msc3381.poll.response"] as any)?.answers?.[0] ??
            (content["m.poll.response"] as any)?.answers?.[0];
          if (answerId) session.votes.set(sender, answerId);
          await updateVoteCount(client, session);
          if (autoReveal && session.voters.size === session.allowedVoters.size) {
            await endPoll(client, session);
          }
        }
      };

      client.on(RoomEvent.Timeline, async (event, _room, toStartOfTimeline) => {
        if (toStartOfTimeline) return;
        if (event.isEncrypted() && !event.getClearContent()) {
          event.once(MatrixEventEvent.Decrypted, () => {
            processEvent(event).catch(err => log.error("poker decrypted event error:", errMsg(err)));
          });
          return;
        }
        await processEvent(event);
      });
      return Promise.resolve();
    });

    // ── Command ───────────────────────────────────────────────────────────────

    registry.register({
      name: "poker",
      module: "poker",
      help: "Start an interactive planning poker refinement session",
      description:
        "Interactive planning poker across a Scrum refinement session. Start with `!poker <story>`, " +
        "the Agile Master claims the role, a selection poll appears to pick participants, then an " +
        "undisclosed poll starts. React 🏁 to reveal votes, ♻️ to revote, ⏭️ to skip. " +
        "Use `!poker next <story>` for the next story, `!poker end` to finish with a session summary. " +
        "Only the AM or a moderator (power ≥ 50) can control the session.",
      usage: "<story> [jira-url] | next <story> [jira-url] | skip | revote | add <name> | remove <name> | end | status | cancel",
      handler: async ({ args, roomId, event, client }) => {
        const sender = event.getSender()!;

        if (pokerRooms.length && !pokerRooms.includes(roomId)) {
          return "Planning poker is not enabled in this room.";
        }

        const sub = args[0]?.toLowerCase();

        if (sub === "status") {
          const s = sessions.get(roomId);
          if (!s) return "No active session in this room.";
          if (s.phase === "awaiting_am") return `Waiting for Agile Master to claim role for: **${s.story}**`;
          if (s.phase === "awaiting_participants") return `Waiting for AM to select participants for: **${s.story}** — ${s.amSelection.length} selected so far`;
          if (s.phase === "polling") return `Active poll: **${s.story}** — ${s.voters.size}/${s.allowedVoters.size} voted`;
          return `Refinement paused after: **${s.story}** — Use \`!poker next <story>\` or \`!poker end\``;
        }

        if (sub === "cancel") {
          const s = sessions.get(roomId);
          if (!s) return "No active session in this room.";
          const amId = s.phase !== "awaiting_am" ? s.am : undefined;
          if (sender !== s.initiator && sender !== amId && !isMod(client, roomId, sender)) {
            return "Only the poll initiator, the Agile Master, or a moderator can cancel.";
          }
          if (s.phase === "polling") {
            await endPoll(client, s, true, true);
          } else {
            if (s.phase === "awaiting_participants") {
              try {
                await (client as any).sendEvent(roomId, "org.matrix.msc3381.poll.end", {
                  "m.relates_to": { rel_type: "m.reference", event_id: s.selectionPollEventId },
                  "org.matrix.msc3381.poll.end": {},
                  "org.matrix.msc1767.text": "Poll cancelled.",
                });
              } catch (err) { log.error("failed to close selection poll:", errMsg(err)); }
            }
            await postSummary(client, roomId, s.history);
            sessions.delete(roomId);
            if (cooldownSecs > 0) cooldowns.set(roomId, Date.now() + cooldownSecs * 1000);
          }
          return "Session cancelled.";
        }

        if (sub === "end") {
          const s = sessions.get(roomId);
          if (!s) return "No active session in this room.";
          const amId = s.phase !== "awaiting_am" ? s.am : undefined;
          if (sender !== s.initiator && sender !== amId && !isMod(client, roomId, sender)) {
            return "Only the poll initiator, the Agile Master, or a moderator can end the refinement.";
          }
          if (s.phase === "polling") {
            await endPoll(client, s, true, true);
          } else {
            if (s.phase === "awaiting_participants") {
              try {
                await (client as any).sendEvent(roomId, "org.matrix.msc3381.poll.end", {
                  "m.relates_to": { rel_type: "m.reference", event_id: s.selectionPollEventId },
                  "org.matrix.msc3381.poll.end": {},
                  "org.matrix.msc1767.text": "Poll cancelled.",
                });
              } catch (err) { log.error("failed to close selection poll:", errMsg(err)); }
            }
            await postSummary(client, roomId, s.history);
            sessions.delete(roomId);
            if (cooldownSecs > 0) cooldowns.set(roomId, Date.now() + cooldownSecs * 1000);
          }
          return "Refinement session ended.";
        }

        if (sub === "skip") {
          const s = sessions.get(roomId);
          if (!s) return "No active session in this room.";
          if (s.phase !== "polling") return "No active poll to skip.";
          if (sender !== s.am && !isMod(client, roomId, sender)) return "Only the Agile Master or a moderator can skip.";
          await skipPoll(client, s);
          return null;
        }

        if (sub === "revote") {
          const s = sessions.get(roomId);
          if (!s) return "No active session in this room.";
          if (s.phase === "polling") {
            if (sender !== s.am && !isMod(client, roomId, sender)) return "Only the Agile Master or a moderator can revote.";
            await revotePoll(client, s);
            return null;
          }
          if (s.phase === "awaiting_next_story") {
            if (sender !== s.am && !isMod(client, roomId, sender)) return "Only the Agile Master or a moderator can revote.";
            await startPolling(client, s, s.voterMembers);
            return null;
          }
          return "No active poll to revote.";
        }

        if (sub === "add") {
          const s = sessions.get(roomId);
          if (!s) return "No active session in this room.";
          if (s.phase !== "polling" && s.phase !== "awaiting_next_story") {
            return "Can only add voters during an active poll or between stories.";
          }
          if (sender !== s.am && !isMod(client, roomId, sender)) return "Only the Agile Master or a moderator can add voters.";
          const query = args.slice(1).join(" ").trim();
          if (!query) return "Usage: `!poker add <name or @userId>`";

          const voterIds = new Set(s.voterMembers.map((m) => m.userId));
          const candidates: EligibleMember[] = (client.getRoom(roomId)?.getMembers() ?? [])
            .filter((m) => m.membership === "join" && !voterIds.has(m.userId) && m.userId !== client.getUserId())
            .map((m) => ({ userId: m.userId, displayName: m.name || m.userId }));

          const match = resolveVoter(query, candidates);
          if (!match) return `Could not find an eligible member matching "${query}".`;

          s.voterMembers.push(match);
          if (s.phase === "polling") {
            s.allowedVoters.add(match.userId);
            await updateVoteCount(client, s);
            if (autoReveal && s.voters.size > 0 && s.voters.size === s.allowedVoters.size) {
              await endPoll(client, s);
              return null;
            }
          }
          return `Added ${match.displayName} as a voter.`;
        }

        if (sub === "remove") {
          const s = sessions.get(roomId);
          if (!s) return "No active session in this room.";
          if (s.phase !== "polling" && s.phase !== "awaiting_next_story") {
            return "Can only remove voters during an active poll or between stories.";
          }
          if (sender !== s.am && !isMod(client, roomId, sender)) return "Only the Agile Master or a moderator can remove voters.";
          const query = args.slice(1).join(" ").trim();
          if (!query) return "Usage: `!poker remove <name or @userId>`";

          const match = resolveVoter(query, s.voterMembers);
          if (!match) return `No voter matching "${query}" found.`;

          const idx = s.voterMembers.findIndex((m) => m.userId === match.userId);
          if (idx >= 0) s.voterMembers.splice(idx, 1);

          if (s.phase === "polling") {
            s.allowedVoters.delete(match.userId);
            s.voters.delete(match.userId);
            s.votes.delete(match.userId);
            await updateVoteCount(client, s);
            if (autoReveal && s.voters.size > 0 && s.voters.size === s.allowedVoters.size) {
              await endPoll(client, s);
              return null;
            }
          }
          return `Removed ${match.displayName} from voters.`;
        }

        if (sub === "next") {
          const s = sessions.get(roomId);
          if (!s) return "No active refinement in this room. Use `!poker <story>` to start one.";
          if (s.phase === "polling") return "A poll is in progress. React 🏁 to reveal before starting the next story.";
          if (s.phase !== "awaiting_next_story") return "No revealed poll to continue from. Use `!poker <story>` to start a new refinement.";
          if (sender !== s.am && !isMod(client, roomId, sender)) return "Only the Agile Master or a moderator can start the next story.";

          let jiraUrl: string | undefined;
          let storyArgs = args.slice(1);
          const lastArg = storyArgs[storyArgs.length - 1] ?? "";
          if (lastArg.startsWith("https://")) {
            if (jiraBase && !lastArg.startsWith(jiraBase)) {
              return `Jira URL must start with \`${jiraBase}\`.`;
            }
            jiraUrl = lastArg;
            storyArgs = storyArgs.slice(0, -1);
          }
          const story = storyArgs.join(" ");
          if (!story) return "Please provide a story description.";
          if (story.length > 200) return "Story description is too long (max 200 characters).";

          await startPolling(client, { roomId, story, jiraUrl, initiator: s.initiator, am: s.am, history: s.history }, s.voterMembers);
          return null;
        }

        if (!args.length) {
          return "Usage: `!poker <story> [jira-url] | next <story> [jira-url] | skip | revote | add <name> | remove <name> | end | status | cancel`";
        }

        if (sessions.has(roomId)) {
          return "A session is already active in this room. Use `!poker cancel` to end it first.";
        }

        const cooldownUntil = cooldowns.get(roomId);
        if (cooldownUntil && Date.now() < cooldownUntil) {
          const secsLeft = Math.ceil((cooldownUntil - Date.now()) / 1000);
          return `Please wait ${secsLeft}s before starting a new session.`;
        }

        let jiraUrl: string | undefined;
        let storyArgs = [...args];
        const lastArg = storyArgs[storyArgs.length - 1] ?? "";
        if (lastArg.startsWith("https://")) {
          if (jiraBase && !lastArg.startsWith(jiraBase)) {
            return `Jira URL must start with \`${jiraBase}\`.`;
          }
          jiraUrl = lastArg;
          storyArgs = storyArgs.slice(0, -1);
        }

        const story = storyArgs.join(" ");
        if (!story) return "Please provide a story description.";
        if (story.length > 200) return "Story description is too long (max 200 characters).";

        sessions.set(roomId, { phase: "awaiting_am", roomId, story, jiraUrl, initiator: sender, history: [] });
        log.info(`session started in ${roomId}: "${story}"`);

        return (
          `🃏 Planning poker started for: **${story}**\n` +
          `Who is the Agile Master? Claim the role by posting: \`I'm the agile master\` or \`!AM\``
        );
      },
    });

    registry.register({
      name: "am",
      module: "poker",
      help: "Claim the Agile Master role or confirm participant selection in an active poker session",
      usage: "",
      handler: async ({ roomId, event, client }) => {
        const sender = event.getSender()!;
        const s = sessions.get(roomId);
        if (!s) return null;

        if (s.phase === "awaiting_am") {
          await claimAM(client, roomId, s, sender);
          return null;
        }

        if (s.phase === "awaiting_participants" && (sender === s.am || isMod(client, roomId, sender))) {
          const selected = s.eligible.filter((m) => s.amSelection.includes(m.userId));
          if (selected.length === 0) return "No participants selected yet. Vote in the selection poll first.";
          await closeSelectionAndStart(client, s, selected);
          return null;
        }

        return null;
      },
    });
  },
};

module.exports = mod;
module.exports.parseParticipants = parseParticipants;
module.exports.getEligibleMembers = getEligibleMembers;
