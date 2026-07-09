import { ModuleRegistry } from "lumi";
import { BotConfig } from "lumi";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseParticipants } = require("../src/poker") as {
  parseParticipants: (input: string, eligible: any[]) => { selected: any[]; unknown: string[] };
};

const mockConfig: BotConfig = {
  homeserver: "", userId: "", accessToken: "",
  prometheusUrl: "", hassUrl: "", hassToken: "", grafanaUrl: "", grafanaToken: "",
  httpAllowedDomains: [], weatherEnabled: false, logLevel: "info",
  e2eeEnabled: false, deviceId: "", cryptoPassword: "", cryptoSaveInterval: 60,
};

const ELIGIBLE = [
  { userId: "@alice:m.org",   displayName: "Alice" },
  { userId: "@bob:m.org",     displayName: "Bob" },
  { userId: "@charlie:m.org", displayName: "Charlie" },
];

function makeCtx(args: string[], roomId = "!room:m.org", sender = "@initiator:m.org", client = makeClient()) {
  return { client, roomId, event: { getSender: () => sender } as any, args };
}

function makeClient(overrides: Record<string, jest.Mock> = {}) {
  return {
    // sendEvent returns selection-poll-id first, then poker-poll-id for subsequent calls
    sendEvent:   jest.fn()
      .mockResolvedValueOnce({ event_id: "$selection-poll-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" }),
    // sendMessage returns reveal-msg-id for all calls (confirm message no longer stores its ID)
    sendMessage: jest.fn()
      .mockResolvedValue({ event_id: "$reveal-msg-id" }),
    getUserId:   jest.fn().mockReturnValue("@bot:m.org"),
    getRoom:     jest.fn().mockReturnValue(null),
    on:          jest.fn(),
    ...overrides,
  } as any;
}

function makeRoom(members: Array<{ userId: string; displayName?: string; powerLevel?: number }>) {
  return {
    getMembers: () =>
      members.map((m) => ({
        userId: m.userId,
        name: m.displayName ?? m.userId,
        membership: "join",
        powerLevel: m.powerLevel ?? 0,
      })),
    getMember: (userId: string) => {
      const m = members.find((x) => x.userId === userId);
      return m ? { powerLevel: m.powerLevel ?? 0 } : null;
    },
  };
}

function loadMod() {
  jest.resetModules();
  const mod = require("../src/poker");
  const registry = new ModuleRegistry();
  mod.register(registry, mockConfig);
  return registry;
}

/** Call startScheduler to trigger onStart hooks and return the Timeline listener. */
function getListener(registry: ModuleRegistry, client: any): (event: any, room: any, toStart: boolean) => Promise<void> {
  registry.startScheduler(client);
  const call = client.on.mock.calls.find((c: any[]) => c[0] === "Room.timeline");
  expect(call).toBeDefined();
  return call[1];
}

function makeEvent(type: string, content: any, sender: string, roomId = "!room:m.org") {
  return {
    getId:              () => "$evt:m.org",
    getType:            () => type,
    getContent:         () => content,
    getSender:          () => sender,
    getRoomId:          () => roomId,
    isRedacted:         () => false,
    isEncrypted:        () => false,
    getClearContent:    () => null,
    isDecryptionFailure: () => false,
  };
}

afterEach(() => {
  jest.resetModules();
  delete process.env.POKER_ROOMS;
  delete process.env.POKER_JIRA_BASE;
  delete process.env.POKER_TIMEOUT_MINS;
  delete process.env.POKER_COOLDOWN_SECS;
  delete process.env.POKER_AUTO_REVEAL;
  jest.useRealTimers();
});

// ── parseParticipants ─────────────────────────────────────────────────────────

describe("parseParticipants", () => {
  test("`all` selects all eligible members", () => {
    const { selected, unknown } = parseParticipants("all", ELIGIBLE);
    expect(selected).toEqual(ELIGIBLE);
    expect(unknown).toEqual([]);
  });

  test("exact display name match", () => {
    const { selected, unknown } = parseParticipants("Alice, Bob", ELIGIBLE);
    expect(selected.map((m) => m.userId)).toEqual(["@alice:m.org", "@bob:m.org"]);
    expect(unknown).toEqual([]);
  });

  test("prefix match (case-insensitive)", () => {
    const { selected } = parseParticipants("ali", ELIGIBLE);
    expect(selected[0].userId).toBe("@alice:m.org");
  });

  test("unknown name goes to unknown array", () => {
    const { selected, unknown } = parseParticipants("Alice, Dave", ELIGIBLE);
    expect(selected).toHaveLength(1);
    expect(unknown).toEqual(["Dave"]);
  });

  test("deduplicates repeated names", () => {
    const { selected } = parseParticipants("Alice, Alice", ELIGIBLE);
    expect(selected).toHaveLength(1);
  });
});

// ── Registration ──────────────────────────────────────────────────────────────

describe("module registration", () => {
  test("registers the poker command", () => {
    expect(loadMod().get("poker")).toBeDefined();
  });
  test("registers the am command", () => {
    expect(loadMod().get("am")).toBeDefined();
  });
});

// ── Room allowlist ────────────────────────────────────────────────────────────

describe("POKER_ROOMS allowlist", () => {
  test("blocks command in disallowed room", async () => {
    process.env.POKER_ROOMS = "!allowed:m.org";
    const result = await loadMod().get("poker")!.handler(makeCtx(["Fix bug"], "!other:m.org"));
    expect(result).toContain("not enabled");
  });

  test("allows command in allowed room", async () => {
    process.env.POKER_ROOMS = "!room:m.org";
    const result = await loadMod().get("poker")!.handler(makeCtx(["Fix bug"]));
    expect(result).toContain("Agile Master");
  });
});

// ── !poker <story> → awaiting AM ─────────────────────────────────────────────

describe("!poker <story>", () => {
  test("returns AM prompt and stores awaiting_am state", async () => {
    const registry = loadMod();
    const result = await registry.get("poker")!.handler(makeCtx(["Fix login bug"]));
    expect(result).toContain("Agile Master");
    expect(result).toContain("Fix login bug");
  });

  test("returns error when no args given", async () => {
    const result = await loadMod().get("poker")!.handler(makeCtx([]));
    expect(result).toContain("Usage");
  });

  test("returns error when second session started in same room", async () => {
    const registry = loadMod();
    const cmd = registry.get("poker")!;
    await cmd.handler(makeCtx(["First story"]));
    const result = await cmd.handler(makeCtx(["Second story"]));
    expect(result).toContain("already active");
  });

  test("Jira URL parsed from last arg", async () => {
    const client = makeClient();
    const registry = loadMod();
    const result = await registry.get("poker")!.handler(
      makeCtx(["Fix bug", "https://jira.example.com/browse/X-1"], "!room:m.org", "@init:m.org", client),
    );
    expect(result).toContain("Fix bug");
    expect(result).not.toContain("jira.example.com");
  });

  test("rejects Jira URL outside POKER_JIRA_BASE", async () => {
    process.env.POKER_JIRA_BASE = "https://jira.myco.com";
    const result = await loadMod().get("poker")!.handler(makeCtx(["Fix bug", "https://evil.com/X-1"]));
    expect(result).toContain("must start with");
  });
});

// ── AM keyword claim ──────────────────────────────────────────────────────────

describe("AM keyword", () => {
  test("valid phrase transitions to awaiting_participants and sends selection poll", async () => {
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org" },
    ]);
    const client = makeClient({ getRoom: jest.fn().mockReturnValue(room) });
    const registry = loadMod();
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));

    client.sendEvent.mockClear();
    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValueOnce({ event_id: "$selection-poll-id" });

    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);

    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.start", expect.objectContaining({
        "org.matrix.msc3381.poll.start": expect.objectContaining({
          question: expect.objectContaining({ "org.matrix.msc1767.text": "Who should vote?" }),
        }),
      }),
    );
    expect(client.sendMessage).toHaveBeenCalledWith(
      "!room:m.org",
      expect.objectContaining({ body: expect.stringContaining("Agile Master") }),
    );
  });

  test("!AM command claims the role", async () => {
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org" },
    ]);
    const client = makeClient({ getRoom: jest.fn().mockReturnValue(room) });
    const registry = loadMod();
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));

    client.sendEvent.mockClear();
    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValueOnce({ event_id: "$selection-poll-id" });

    await registry.get("am")!.handler(makeCtx([], "!room:m.org", "@am:m.org", client));
    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.start", expect.anything(),
    );
  });

  test("!AM command returns null when no active session", async () => {
    const result = await loadMod().get("am")!.handler(makeCtx([], "!room:m.org", "@am:m.org"));
    expect(result).toBeNull();
  });

  test("unrelated message does not advance state", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));

    client.sendMessage.mockClear();
    await listener(makeEvent("m.room.message", { body: "Hello everyone" }, "@am:m.org"), null, false);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  test("cancels session when no eligible voters exist", async () => {
    const room = makeRoom([{ userId: "@am:m.org" }]);
    const client = makeClient({ getRoom: jest.fn().mockReturnValue(room) });
    const registry = loadMod();
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));

    client.sendMessage.mockClear();
    await listener(makeEvent("m.room.message", { body: "I am the agile master" }, "@am:m.org"), null, false);

    expect(client.sendMessage).toHaveBeenCalledWith(
      "!room:m.org",
      expect.objectContaining({ body: expect.stringContaining("No eligible voters") }),
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"]));
    expect(status).toContain("No active");
  });
});

// ── AM keyword reply guard ────────────────────────────────────────────────────

describe("AM keyword reply guard", () => {
  test("quoted reply with AM phrase does not trigger AM claim", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));

    client.sendMessage.mockClear();
    await listener(
      makeEvent(
        "m.room.message",
        { body: "I'm the agile master", "m.relates_to": { rel_type: "m.reply", event_id: "$some-event" } },
        "@am:m.org",
      ),
      null, false,
    );
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

// ── Participant selection poll ────────────────────────────────────────────────

describe("participant selection poll", () => {
  async function setupAwaitingParticipants(client: any, registry: ModuleRegistry) {
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
      { userId: "@bob:m.org",   displayName: "Bob" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    // claimAM via timeline phrase
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockClear();
    client.sendMessage.mockClear();
    // Subsequent sendEvent: first = poll.end for selection, next = poker poll.start
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    return listener;
  }

  test("AM poll.response updates amSelection", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupAwaitingParticipants(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    // status shows 1 selected
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("1 selected");
  });

  test("AM poll.response (stable type) updates amSelection", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupAwaitingParticipants(client, registry);

    await listener(
      makeEvent("m.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "m.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("1 selected");
  });

  test("non-AM poll.response for selection poll is ignored", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupAwaitingParticipants(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@alice:m.org"),
      null, false,
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("0 selected");
  });

  test("AM reacts ✅ with selection → starts poker poll", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupAwaitingParticipants(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"),
      null, false,
    );

    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.start", expect.anything(),
    );
  });

  test("AM reacts ✅ with empty selection → error message", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupAwaitingParticipants(client, registry);

    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"),
      null, false,
    );

    expect(client.sendMessage).toHaveBeenCalledWith(
      "!room:m.org",
      expect.objectContaining({ body: expect.stringContaining("No participants selected") }),
    );
    expect(client.sendEvent).not.toHaveBeenCalled();
  });

  test("non-AM ✅ reaction is ignored", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupAwaitingParticipants(client, registry);

    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@alice:m.org"),
      null, false,
    );
    expect(client.sendEvent).not.toHaveBeenCalled();
  });

  test("!AM confirms selection and starts poll", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupAwaitingParticipants(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    await registry.get("am")!.handler(makeCtx([], "!room:m.org", "@am:m.org", client));

    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.start", expect.anything(),
    );
  });

  test("!AM with empty selection returns error", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAwaitingParticipants(client, registry);

    const result = await registry.get("am")!.handler(makeCtx([], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("No participants selected");
  });

  test("!poker cancel in awaiting_participants closes selection poll", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAwaitingParticipants(client, registry);

    const result = await registry.get("poker")!.handler(
      makeCtx(["cancel"], "!room:m.org", "@init:m.org", client),
    );
    expect(result).toContain("cancelled");
    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.end", expect.anything(),
    );
  });
});

// ── AM excluded from vote count ───────────────────────────────────────────────

describe("AM vote exclusion", () => {
  async function setupPolling(client: any, registry: ModuleRegistry) {
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    // AM claims
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    // Reset mocks, then: poll.end for selection, poker poll.start, reveal msg
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    // AM votes in selection poll (alice) and confirms
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"),
      null, false,
    );
    client.sendMessage.mockClear();
    return listener;
  }

  test("AM poll response is not counted", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPolling(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" } }, "@am:m.org"),
      null, false,
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("0/");
  });

  test("eligible voter response is counted", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPolling(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" } }, "@alice:m.org"),
      null, false,
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@init:m.org", client));
    expect(status).toContain("1/");
  });

  test("eligible voter response (stable type) is counted", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPolling(client, registry);

    await listener(
      makeEvent("m.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "m.poll.response": { answers: ["5"] } }, "@alice:m.org"),
      null, false,
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@init:m.org", client));
    expect(status).toContain("1/");
  });

  test("non-allowed voter response is not counted", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPolling(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" } }, "@stranger:m.org"),
      null, false,
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@init:m.org", client));
    expect(status).toContain("0/");
  });

  test("auto-reveal ends poll when all eligible voters have voted", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPolling(client, registry);

    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"),
      null, false,
    );

    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.end", expect.anything(),
    );
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@init:m.org", client));
    expect(status).toContain("Refinement paused");
  });

  test("auto-reveal disabled via POKER_AUTO_REVEAL=false", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPolling(client, registry);

    client.sendEvent.mockClear();
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"),
      null, false,
    );

    expect(client.sendEvent).not.toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.end", expect.anything(),
    );
  });
});

// ── !poker status ─────────────────────────────────────────────────────────────

describe("!poker status", () => {
  test("no session returns message", async () => {
    const result = await loadMod().get("poker")!.handler(makeCtx(["status"]));
    expect(result).toContain("No active");
  });

  test("awaiting_am phase message", async () => {
    const registry = loadMod();
    const cmd = registry.get("poker")!;
    await cmd.handler(makeCtx(["Fix bug"]));
    const result = await cmd.handler(makeCtx(["status"]));
    expect(result).toContain("Agile Master");
    expect(result).toContain("Fix bug");
  });
});

// ── !poker cancel ─────────────────────────────────────────────────────────────

describe("!poker cancel", () => {
  test("no session returns message", async () => {
    const result = await loadMod().get("poker")!.handler(makeCtx(["cancel"]));
    expect(result).toContain("No active");
  });

  test("initiator can cancel awaiting_am session", async () => {
    const registry = loadMod();
    const cmd = registry.get("poker")!;
    await cmd.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org"));
    const result = await cmd.handler(makeCtx(["cancel"], "!room:m.org", "@init:m.org"));
    expect(result).toContain("cancelled");
  });

  test("random user cannot cancel", async () => {
    const registry = loadMod();
    const cmd = registry.get("poker")!;
    await cmd.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org"));
    const result = await cmd.handler(makeCtx(["cancel"], "!room:m.org", "@random:m.org"));
    expect(result).toContain("Only the poll initiator");
  });

  test("moderator can cancel", async () => {
    const room = makeRoom([{ userId: "@mod:m.org", powerLevel: 50 }]);
    const client = makeClient({ getRoom: jest.fn().mockReturnValue(room) });
    const registry = loadMod();
    const cmd = registry.get("poker")!;
    await cmd.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    const result = await cmd.handler(makeCtx(["cancel"], "!room:m.org", "@mod:m.org", client));
    expect(result).toContain("cancelled");
  });
});

// ── Cooldown ──────────────────────────────────────────────────────────────────

describe("POKER_COOLDOWN_SECS", () => {
  test("blocks new session during cooldown", async () => {
    process.env.POKER_COOLDOWN_SECS = "60";
    jest.useFakeTimers();
    const registry = loadMod();
    const cmd = registry.get("poker")!;
    await cmd.handler(makeCtx(["Fix bug"]));
    await cmd.handler(makeCtx(["cancel"]));
    const result = await cmd.handler(makeCtx(["New story"]));
    expect(result).toContain("wait");
  });

  test("allows new session after cooldown", async () => {
    process.env.POKER_COOLDOWN_SECS = "60";
    jest.useFakeTimers();
    const registry = loadMod();
    const cmd = registry.get("poker")!;
    await cmd.handler(makeCtx(["Fix bug"]));
    await cmd.handler(makeCtx(["cancel"]));
    jest.advanceTimersByTime(61_000);
    const result = await cmd.handler(makeCtx(["New story"]));
    expect(result).toContain("Agile Master");
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe("POKER_TIMEOUT_MINS", () => {
  async function setupPolling(client: any, registry: ModuleRegistry) {
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"),
      null, false,
    );
    return listener;
  }

  test("auto-cancels poll after timeout", async () => {
    process.env.POKER_TIMEOUT_MINS = "1";
    jest.useFakeTimers();
    const client = makeClient();
    const registry = loadMod();
    await setupPolling(client, registry);

    client.sendEvent.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    jest.advanceTimersByTime(60_000);
    await Promise.resolve();

    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.end", expect.anything(),
    );
  });
});

// ── Vote statistics ───────────────────────────────────────────────────────────

describe("vote statistics", () => {
  async function setupPollingWithVote(client: any, registry: ModuleRegistry) {
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
      { userId: "@bob:m.org",   displayName: "Bob" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org", "@bob:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"),
      null, false,
    );
    return listener;
  }

  test("stats message sent with 📊 after 🏁 reveal", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPollingWithVote(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$poll-event-id" },
        "org.matrix.msc3381.poll.response": { answers: ["5"] },
      }, "@alice:m.org"),
      null, false,
    );

    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"),
      null, false,
    );

    const statsCalls = (client.sendMessage.mock.calls as any[]).filter(
      (c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"),
    );
    expect(statsCalls.length).toBeGreaterThan(0);
    expect(statsCalls[0][1].body).toContain("1/");
  });

  test("stats shows only voted options", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPollingWithVote(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$poll-event-id" },
        "org.matrix.msc3381.poll.response": { answers: ["8"] },
      }, "@alice:m.org"),
      null, false,
    );

    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"),
      null, false,
    );

    const statsBody = (client.sendMessage.mock.calls as any[]).find(
      (c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"),
    )?.[1].body as string;
    expect(statsBody).toContain("8");
    expect(statsBody).not.toContain("5");
  });

  test("stats shows 0 voted when nobody voted", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPollingWithVote(client, registry);

    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"),
      null, false,
    );

    const statsBody = (client.sendMessage.mock.calls as any[]).find(
      (c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"),
    )?.[1].body as string;
    expect(statsBody).toContain("0/");
  });

  test("re-vote counts only latest answer", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPollingWithVote(client, registry);

    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$poll-event-id" },
        "org.matrix.msc3381.poll.response": { answers: ["3"] },
      }, "@alice:m.org"),
      null, false,
    );
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$poll-event-id" },
        "org.matrix.msc3381.poll.response": { answers: ["8"] },
      }, "@alice:m.org"),
      null, false,
    );

    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"),
      null, false,
    );

    const statsBody = (client.sendMessage.mock.calls as any[]).find(
      (c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"),
    )?.[1].body as string;
    expect(statsBody).toMatch(/^8\s/m);
    expect(statsBody).not.toMatch(/^3\s/m);
  });

  test("♻️ revote closes old poll, resets votes, and starts new poll", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPollingWithVote(client, registry);

    // Alice votes before the revote
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$poll-event-id" },
        "org.matrix.msc3381.poll.response": { answers: ["5"] },
      }, "@alice:m.org"),
      null, false,
    );

    client.sendEvent.mockClear();
    client.sendMessage.mockClear();
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$revote-end-id" })
      .mockResolvedValue({ event_id: "$new-poll-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$new-reveal-id" });

    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "♻️", event_id: "$reveal-msg-id" } }, "@am:m.org"),
      null, false,
    );

    const sendEventCalls = client.sendEvent.mock.calls as any[];
    const pollEndCalls = sendEventCalls.filter(
      (c) => c[1] === "org.matrix.msc3381.poll.end" && c[2]?.["m.relates_to"]?.event_id === "$poll-event-id",
    );
    expect(pollEndCalls).toHaveLength(1);

    const newPollCalls = sendEventCalls.filter((c) => c[1] === "org.matrix.msc3381.poll.start");
    expect(newPollCalls).toHaveLength(1);

    const revealBody = (client.sendMessage.mock.calls as any[])
      .map((c) => c[1]?.body as string)
      .find((b) => typeof b === "string" && b.includes("voted"));
    expect(revealBody).toContain("0/2");
  });
});

// ── Refinement session ────────────────────────────────────────────────────────

describe("refinement session", () => {
  async function setupAndReveal(client: any, registry: ModuleRegistry) {
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    // selection → confirm
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"),
      null, false,
    );
    // 🏁 to reveal
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"),
      null, false,
    );
    client.sendMessage.mockClear();
    return listener;
  }

  test("after 🏁 reveal, status shows awaiting_next_story message", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("Refinement paused");
    expect(status).toContain("Fix bug");
  });

  test("!poker next from AM starts a new poll", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    client.sendEvent.mockResolvedValue({ event_id: "$poll2-event-id" });
    await registry.get("poker")!.handler(makeCtx(["next", "Second", "story"], "!room:m.org", "@am:m.org", client));

    expect(client.sendEvent).toHaveBeenCalledWith(
      "!room:m.org", "org.matrix.msc3381.poll.start", expect.anything(),
    );
  });

  test("!poker next from non-AM non-mod is rejected", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    const result = await registry.get("poker")!.handler(
      makeCtx(["next", "Second story"], "!room:m.org", "@random:m.org", client),
    );
    expect(result).toContain("Agile Master");
  });

  test("!poker next with no story description returns error", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    const result = await registry.get("poker")!.handler(makeCtx(["next"], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("story description");
  });

  test("!poker next during active polling is rejected", async () => {
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(
      makeEvent("org.matrix.msc3381.poll.response", {
        "m.relates_to": { event_id: "$selection-poll-id" },
        "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] },
      }, "@am:m.org"),
      null, false,
    );
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"),
      null, false,
    );

    const result = await registry.get("poker")!.handler(
      makeCtx(["next", "Other story"], "!room:m.org", "@am:m.org", client),
    );
    expect(result).toContain("in progress");
  });

  test("!poker next with no session returns error", async () => {
    const result = await loadMod().get("poker")!.handler(makeCtx(["next", "Story"]));
    expect(result).toContain("No active refinement");
  });

  test("!poker end from AM ends the refinement", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    const result = await registry.get("poker")!.handler(makeCtx(["end"], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("ended");

    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("No active");
  });

  test("!poker end from non-AM non-mod is rejected", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    const result = await registry.get("poker")!.handler(
      makeCtx(["end"], "!room:m.org", "@random:m.org", client),
    );
    expect(result).toContain("Only the poll initiator");
  });

  test("cooldown is applied after !poker end", async () => {
    process.env.POKER_COOLDOWN_SECS = "60";
    jest.useFakeTimers();
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    await registry.get("poker")!.handler(makeCtx(["end"], "!room:m.org", "@am:m.org", client));
    const result = await registry.get("poker")!.handler(makeCtx(["New story"], "!room:m.org", "@init:m.org", client));
    expect(result).toContain("wait");
  });

  test("!poker cancel in awaiting_next_story ends the refinement", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupAndReveal(client, registry);

    const result = await registry.get("poker")!.handler(makeCtx(["cancel"], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("cancelled");

    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("No active");
  });
});

// ── Decryption failure guard ──────────────────────────────────────────────────

describe("decryption failure guard", () => {
  test("event with isDecryptionFailure=true does not advance session state", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));

    const badEvent = {
      ...makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"),
      isDecryptionFailure: () => true,
    };
    client.sendMessage.mockClear();
    await listener(badEvent, null, false);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

// ── Story length limit ────────────────────────────────────────────────────────

describe("story length limit", () => {
  test("!poker with 201-char story is rejected", async () => {
    const story = "a".repeat(201);
    const result = await loadMod().get("poker")!.handler(makeCtx([story]));
    expect(result).toContain("too long");
  });

  test("!poker with 200-char story is accepted", async () => {
    const story = "a".repeat(200);
    const result = await loadMod().get("poker")!.handler(makeCtx([story]));
    expect(result).toContain("Agile Master");
  });

  test("!poker next with 201-char story is rejected", async () => {
    const client = makeClient();
    const registry = loadMod();

    // Set up a revealed session so we're in awaiting_next_story
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$selection-end-id" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);

    const story = "b".repeat(201);
    const result = await registry.get("poker")!.handler(makeCtx(["next", story], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("too long");
  });
});

// ── Revote from awaiting_next_story ───────────────────────────────────────────

describe("♻️ revote from awaiting_next_story", () => {
  test("♻️ reaction after auto-reveal starts a new poll with same participants", async () => {
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"), null, false);
    // auto-close via 🏁
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);

    // now in awaiting_next_story — react ♻️
    client.sendEvent.mockClear();
    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$revote-poll-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$revote-reveal-id" });

    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "♻️", event_id: "$any-msg" } }, "@am:m.org"),
      null, false,
    );

    const newPollCalls = (client.sendEvent.mock.calls as any[]).filter((c) => c[1] === "org.matrix.msc3381.poll.start");
    expect(newPollCalls).toHaveLength(1);

    const revealBody = (client.sendMessage.mock.calls as any[])
      .map((c) => c[1]?.body as string)
      .find((b) => typeof b === "string" && b.includes("voted"));
    expect(revealBody).toContain("0/1");
  });

  test("non-AM ♻️ reaction in awaiting_next_story is ignored", async () => {
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent
      .mockResolvedValueOnce({ event_id: "$selection-end-id" })
      .mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$confirm-msg-id" } }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValue({ event_id: "$end-event" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);

    client.sendEvent.mockClear();
    await listener(
      makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "♻️", event_id: "$any-msg" } }, "@alice:m.org"),
      null, false,
    );

    const newPollCalls = (client.sendEvent.mock.calls as any[]).filter((c) => c[1] === "org.matrix.msc3381.poll.start");
    expect(newPollCalls).toHaveLength(0);
  });
});

// ── Reveal message "Waiting on" (feature 1) ───────────────────────────────────

describe("reveal message — Waiting on", () => {
  async function setup2Voters(client: any, registry: ModuleRegistry) {
    process.env.POKER_AUTO_REVEAL = "false";
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
      { userId: "@bob:m.org",   displayName: "Bob" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org", "@bob:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    return listener;
  }

  test("initial reveal message lists all voters as waiting", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setup2Voters(client, registry);
    const revealBody = (client.sendMessage.mock.calls as any[])
      .map((c) => c[1]?.body as string).find((b) => typeof b === "string" && b.includes("voted"));
    expect(revealBody).toContain("Waiting on:");
    expect(revealBody).toContain("Alice");
    expect(revealBody).toContain("Bob");
  });

  test("after alice votes, only Bob shown as waiting", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setup2Voters(client, registry);
    client.sendMessage.mockClear();
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);
    const body = (client.sendMessage.mock.calls as any[]).map((c) => c[1]?.body as string).find((b) => typeof b === "string" && b.includes("voted"));
    expect(body).toContain("Waiting on: Bob");
    expect(body).not.toContain("Alice");
  });

  test("when all voted, no waiting suffix in reveal message", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setup2Voters(client, registry);
    client.sendMessage.mockClear();
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@bob:m.org"), null, false);
    const bodies = (client.sendMessage.mock.calls as any[]).map((c) => c[1]?.body as string).filter((b) => typeof b === "string" && b.includes("voted"));
    const lastReveal = bodies[bodies.length - 1];
    expect(lastReveal).not.toContain("Waiting on");
  });
});

// ── Consensus line (feature 2) ────────────────────────────────────────────────

describe("consensus line in stats", () => {
  async function setupAndRevealWith(client: any, votes: Record<string, string>) {
    process.env.POKER_AUTO_REVEAL = "false";
    const registry = loadMod();
    const voters = Object.keys(votes);
    const room = makeRoom([
      { userId: "@init:m.org" },
      { userId: "@am:m.org" },
      ...voters.map((u) => ({ userId: u, displayName: u.split(":")[0]?.slice(1) ?? u })),
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: voters } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    for (const [userId, answer] of Object.entries(votes)) {
      await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: [answer] } }, userId), null, false);
    }
    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-evt" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);
    return (client.sendMessage.mock.calls as any[]).find((c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"))?.[1].body as string;
  }

  test("all same score → ✅ Consensus", async () => {
    const client = makeClient();
    const stats = await setupAndRevealWith(client, { "@alice:m.org": "5", "@bob:m.org": "5" });
    expect(stats).toContain("✅ Consensus: 5");
  });

  test("adjacent Fibonacci scores → ~Rough consensus", async () => {
    const client = makeClient();
    const stats = await setupAndRevealWith(client, { "@alice:m.org": "3", "@bob:m.org": "5" });
    expect(stats).toContain("~Rough consensus: 3–5");
  });

  test("wide spread → ⚠️ Spread", async () => {
    const client = makeClient();
    const stats = await setupAndRevealWith(client, { "@alice:m.org": "1", "@bob:m.org": "8" });
    expect(stats).toContain("⚠️ Spread: 1–8");
  });

  test("no votes → no consensus line", async () => {
    const client = makeClient();
    const stats = await setupAndRevealWith(client, {});
    expect(stats ?? "").not.toContain("Consensus");
    expect(stats ?? "").not.toContain("Spread");
  });
});

// ── Non-voter mention on reveal (feature 6) ───────────────────────────────────

describe("non-voter mention on reveal", () => {
  test("stats includes 'No vote from' for voters who didn't vote", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" }, { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
      { userId: "@bob:m.org",   displayName: "Bob" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org", "@bob:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);

    // Only alice votes
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);

    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-evt" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);

    const statsBody = (client.sendMessage.mock.calls as any[]).find((c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"))?.[1].body as string;
    expect(statsBody).toContain("No vote from: Bob");
    expect(statsBody).not.toContain("Alice");
  });

  test("stats has no 'No vote from' when all voted", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" }, { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);

    client.sendMessage.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$end-evt" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);

    const statsBody = (client.sendMessage.mock.calls as any[]).find((c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"))?.[1].body as string;
    expect(statsBody).not.toContain("No vote from");
  });
});

// ── !poker skip (feature 4) ───────────────────────────────────────────────────

describe("!poker skip", () => {
  async function setupPollingForSkip(client: any, registry: ModuleRegistry) {
    const room = makeRoom([
      { userId: "@init:m.org" }, { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    return listener;
  }

  test("!poker skip from polling transitions to awaiting_next_story", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    await setupPollingForSkip(client, registry);
    client.sendEvent.mockResolvedValue({ event_id: "$skip-end" });
    const result = await registry.get("poker")!.handler(makeCtx(["skip"], "!room:m.org", "@am:m.org", client));
    expect(result).toBeNull();
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("Refinement paused");
  });

  test("!poker skip from non-polling returns error", async () => {
    const result = await loadMod().get("poker")!.handler(makeCtx(["skip"]));
    expect(result).toContain("No active session");
  });

  test("!poker skip by non-AM is rejected", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    await setupPollingForSkip(client, registry);
    const result = await registry.get("poker")!.handler(makeCtx(["skip"], "!room:m.org", "@alice:m.org", client));
    expect(result).toContain("Agile Master");
  });

  test("⏭️ reaction skips active poll", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPollingForSkip(client, registry);
    client.sendEvent.mockResolvedValue({ event_id: "$skip-end" });
    client.sendMessage.mockClear();
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "⏭️", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);
    const skipMsgCalls = (client.sendMessage.mock.calls as any[]).filter((c) => typeof c[1]?.body === "string" && c[1].body.includes("skipped"));
    expect(skipMsgCalls.length).toBeGreaterThan(0);
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("Refinement paused");
  });

  test("skip records story with null score in history", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    await setupPollingForSkip(client, registry);
    client.sendEvent.mockResolvedValue({ event_id: "$skip-end" });
    await registry.get("poker")!.handler(makeCtx(["skip"], "!room:m.org", "@am:m.org", client));
    // After skip, end the session — summary should mention 1 skipped
    client.sendEvent.mockResolvedValue({ event_id: "$end-evt" });
    client.sendMessage.mockClear();
    await registry.get("poker")!.handler(makeCtx(["end"], "!room:m.org", "@am:m.org", client));
    const summaryBody = (client.sendMessage.mock.calls as any[]).find((c) => typeof c[1]?.body === "string" && c[1].body.includes("📋"))?.[1].body as string;
    expect(summaryBody).toContain("skipped");
  });
});

// ── Session summary (feature 5) ───────────────────────────────────────────────

describe("session summary at !poker end", () => {
  test("summary posted with bar chart after multi-story session", async () => {
    process.env.POKER_AUTO_REVEAL = "false";
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" }, { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Story one"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    // vote + reveal story 1
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);
    client.sendEvent.mockResolvedValue({ event_id: "$end-1" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);
    // start story 2
    client.sendEvent.mockResolvedValue({ event_id: "$poll-event-id-2" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id-2" });
    await registry.get("poker")!.handler(makeCtx(["next", "Story two"], "!room:m.org", "@am:m.org", client));
    // vote + reveal story 2
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id-2" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);
    client.sendEvent.mockResolvedValue({ event_id: "$end-2" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id-2" } }, "@am:m.org"), null, false);
    // end session
    client.sendMessage.mockClear();
    await registry.get("poker")!.handler(makeCtx(["end"], "!room:m.org", "@am:m.org", client));
    const summaryBody = (client.sendMessage.mock.calls as any[]).find((c) => typeof c[1]?.body === "string" && c[1].body.includes("📋"))?.[1].body as string;
    expect(summaryBody).toContain("Refinement complete");
    expect(summaryBody).toContain("2 stories");
    expect(summaryBody).toContain("5");
  });

  test("no summary posted when no stories completed", async () => {
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([{ userId: "@init:m.org" }, { userId: "@am:m.org" }]);
    client.getRoom.mockReturnValue(room);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    client.sendMessage.mockClear();
    await registry.get("poker")!.handler(makeCtx(["cancel"], "!room:m.org", "@init:m.org", client));
    const summaryCalls = (client.sendMessage.mock.calls as any[]).filter((c) => typeof c[1]?.body === "string" && c[1].body.includes("📋"));
    expect(summaryCalls).toHaveLength(0);
  });
});

// ── !poker revote command (feature 3) ─────────────────────────────────────────

describe("!poker revote command", () => {
  async function setupPolling1(client: any, registry: ModuleRegistry) {
    process.env.POKER_AUTO_REVEAL = "false";
    const room = makeRoom([{ userId: "@init:m.org" }, { userId: "@am:m.org" }, { userId: "@alice:m.org", displayName: "Alice" }]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    return listener;
  }

  test("!poker revote in polling restarts poll", async () => {
    const client = makeClient();
    const registry = loadMod();
    await setupPolling1(client, registry);
    client.sendEvent.mockClear();
    client.sendEvent.mockResolvedValueOnce({ event_id: "$revote-end" }).mockResolvedValue({ event_id: "$new-poll-id" });
    await registry.get("poker")!.handler(makeCtx(["revote"], "!room:m.org", "@am:m.org", client));
    const newPoll = (client.sendEvent.mock.calls as any[]).filter((c) => c[1] === "org.matrix.msc3381.poll.start");
    expect(newPoll).toHaveLength(1);
  });

  test("!poker revote in awaiting_next_story starts new poll", async () => {
    const client = makeClient();
    const registry = loadMod();
    const listener = await setupPolling1(client, registry);
    client.sendEvent.mockResolvedValue({ event_id: "$end-evt" });
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "🏁", event_id: "$reveal-msg-id" } }, "@am:m.org"), null, false);
    client.sendEvent.mockClear();
    client.sendEvent.mockResolvedValue({ event_id: "$new-poll-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$new-reveal-id" });
    await registry.get("poker")!.handler(makeCtx(["revote"], "!room:m.org", "@am:m.org", client));
    const newPoll = (client.sendEvent.mock.calls as any[]).filter((c) => c[1] === "org.matrix.msc3381.poll.start");
    expect(newPoll).toHaveLength(1);
  });

  test("!poker revote outside active phases returns error", async () => {
    const result = await loadMod().get("poker")!.handler(makeCtx(["revote"]));
    expect(result).toContain("No active session");
  });
});

// ── !poker add / !poker remove (feature 7) ────────────────────────────────────

describe("!poker add / !poker remove", () => {
  async function setupPollingWithCharlie(client: any) {
    process.env.POKER_AUTO_REVEAL = "false";
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" }, { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
      { userId: "@charlie:m.org", displayName: "Charlie" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    // AM selects only alice (not charlie)
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    return { listener, registry };
  }

  test("!poker add adds a voter to the active poll", async () => {
    const client = makeClient();
    const { registry } = await setupPollingWithCharlie(client);
    const result = await registry.get("poker")!.handler(makeCtx(["add", "Charlie"], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("Added Charlie");
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("0/2");
  });

  test("!poker add with unknown name returns error", async () => {
    const client = makeClient();
    const { registry } = await setupPollingWithCharlie(client);
    const result = await registry.get("poker")!.handler(makeCtx(["add", "Nobody"], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("Could not find");
  });

  test("!poker add by non-AM is rejected", async () => {
    const client = makeClient();
    const { registry } = await setupPollingWithCharlie(client);
    const result = await registry.get("poker")!.handler(makeCtx(["add", "Charlie"], "!room:m.org", "@alice:m.org", client));
    expect(result).toContain("Agile Master");
  });

  test("!poker remove removes a voter and clears their vote", async () => {
    const client = makeClient();
    const { listener, registry } = await setupPollingWithCharlie(client);
    // alice votes
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);
    const result = await registry.get("poker")!.handler(makeCtx(["remove", "Alice"], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("Removed Alice");
    const status = await registry.get("poker")!.handler(makeCtx(["status"], "!room:m.org", "@am:m.org", client));
    expect(status).toContain("0/0");
  });

  test("!poker remove with unknown name returns error", async () => {
    const client = makeClient();
    const { registry } = await setupPollingWithCharlie(client);
    const result = await registry.get("poker")!.handler(makeCtx(["remove", "Nobody"], "!room:m.org", "@am:m.org", client));
    expect(result).toContain("No voter matching");
  });

  test("!poker remove triggers auto-reveal when last remaining voter has voted", async () => {
    const client = makeClient();
    const registry = loadMod();
    const room = makeRoom([
      { userId: "@init:m.org" }, { userId: "@am:m.org" },
      { userId: "@alice:m.org", displayName: "Alice" },
      { userId: "@bob:m.org",   displayName: "Bob" },
    ]);
    client.getRoom.mockReturnValue(room);
    const listener = getListener(registry, client);
    await registry.get("poker")!.handler(makeCtx(["Fix bug"], "!room:m.org", "@init:m.org", client));
    await listener(makeEvent("m.room.message", { body: "I'm the agile master" }, "@am:m.org"), null, false);
    client.sendEvent.mockResolvedValueOnce({ event_id: "$sel-end" }).mockResolvedValue({ event_id: "$poll-event-id" });
    client.sendMessage.mockResolvedValue({ event_id: "$reveal-msg-id" });
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$selection-poll-id" }, "org.matrix.msc3381.poll.response": { answers: ["@alice:m.org", "@bob:m.org"] } }, "@am:m.org"), null, false);
    await listener(makeEvent("m.reaction", { "m.relates_to": { rel_type: "m.annotation", key: "✅", event_id: "$c" } }, "@am:m.org"), null, false);
    // alice votes
    await listener(makeEvent("org.matrix.msc3381.poll.response", { "m.relates_to": { event_id: "$poll-event-id" }, "org.matrix.msc3381.poll.response": { answers: ["5"] } }, "@alice:m.org"), null, false);
    // remove bob (last non-voter) → auto-reveal
    client.sendEvent.mockResolvedValue({ event_id: "$end-evt" });
    client.sendMessage.mockClear();
    await registry.get("poker")!.handler(makeCtx(["remove", "Bob"], "!room:m.org", "@am:m.org", client));
    const statsCalls = (client.sendMessage.mock.calls as any[]).filter((c) => typeof c[1]?.body === "string" && c[1].body.includes("📊"));
    expect(statsCalls.length).toBeGreaterThan(0);
  });
});
