import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ScriptedTurn, scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildColdContext,
  COLD_IDLE_MS,
  COLD_MIN_TOKENS,
  coldRebuildFor,
  describeAction,
  isCold,
  memoryHead,
  recentFiles,
} from "../src/core/cold.ts";
import { AgentRuntime } from "../src/core/runtime.ts";
import { oarHarness } from "../src/harness/harness.ts";
import { type Chat, Store } from "../src/store/store.ts";
import { messageIds, until } from "./helpers.ts";

const HOUR = 3_600_000;

describe("cold-start decision", () => {
  const now = 10 * HOUR;
  const cold = { running: false, idleSince: now - HOUR - 1, tokens: COLD_MIN_TOKENS + 1 };

  it("is cold only when idle past an hour with a context over 128K tokens", () => {
    expect(isCold(cold, now)).toBe(true);
    expect(isCold({ ...cold, idleSince: now - COLD_IDLE_MS }, now)).toBe(false);
    expect(isCold({ ...cold, tokens: COLD_MIN_TOKENS }, now)).toBe(false);
  });

  it("never treats an interjection, or an unknown context size, as cold", () => {
    expect(isCold({ ...cold, running: true }, now)).toBe(false);
    expect(isCold({ ...cold, tokens: null }, now)).toBe(false);
  });

  it("is off unless the dev flag names the agent or says rebuild", () => {
    const agent = { id: "a1b2", slug: "alex" };
    expect(coldRebuildFor(undefined, agent)).toBe(false);
    expect(coldRebuildFor("", agent)).toBe(false);
    expect(coldRebuildFor("1", agent)).toBe(false);
    expect(coldRebuildFor("rebuild", agent)).toBe(true);
    expect(coldRebuildFor("bob, alex", agent)).toBe(true);
    expect(coldRebuildFor("a1b2", agent)).toBe(true);
    expect(coldRebuildFor("bob", agent)).toBe(false);
  });
});

describe("cold-start input", () => {
  let home: string;
  let store: Store;
  let agentId: string;
  let chat: Chat;
  let dm: Chat;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mingle-cold-"));
    store = new Store(`${home}.db`);
    agentId = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" }).id;
    const connection = store.createConnection({ agentId, platform: "telegram", secretRef: "s" });
    chat = store.upsertChat({ connectionId: connection.id, platformId: "-100", kind: "group", name: "Hikes" });
    dm = store.upsertChat({ connectionId: connection.id, platformId: "u1", kind: "dm" });
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${home}.db${suffix}`, { force: true });
  });

  let seq = 0;
  const inbound = (c: Chat, body: string, at: number, triggers = true) =>
    store.insertInbound({
      chatId: c.id,
      platformId: String(++seq),
      senderId: "u1",
      senderName: "Zhang San",
      body,
      attachments: [],
      replyTo: null,
      triggers,
      createdAt: at,
    }) as NonNullable<ReturnType<Store["insertInbound"]>>;

  it("describes a tool call by its telling field", () => {
    expect(describeAction("Bash", '{"command":"pnpm test","description":"run tests"}')).toBe("Bash: pnpm test");
    expect(describeAction("Read", '{"file_path":"notes/trip.md"}')).toBe("Read: notes/trip.md");
    expect(describeAction("Edit", '{"old_string":"a"}')).toBe("Edit");
    expect(describeAction("search", "ridge route\nweather")).toBe("search: ridge route weather");
    expect(describeAction("Bash", `{"command":"${"x".repeat(300)}"}`)).toHaveLength("Bash: ".length + 161);
    expect(describeAction("Bash")).toBe("Bash");
  });

  it("takes the start of MEMORY.md, cut at a line end", () => {
    expect(memoryHead(home)).toEqual({ text: "", cut: false });
    writeFileSync(join(home, "MEMORY.md"), "# Alex\n\n- trip on Saturday\n");
    expect(memoryHead(home)).toEqual({ text: "# Alex\n\n- trip on Saturday", cut: false });
    writeFileSync(join(home, "MEMORY.md"), `${"徒步路线\n".repeat(2000)}`);
    const head = memoryHead(home, 1000);
    expect(head.cut).toBe(true);
    expect(Buffer.byteLength(head.text)).toBeLessThanOrEqual(1000);
    expect(head.text.endsWith("徒步路线")).toBe(true);
    expect(head.text).not.toContain("�");
  });

  it("lists files changed in the last two hours, newest first, without tooling folders", () => {
    const now = Date.now();
    mkdirSync(join(home, "notes"));
    mkdirSync(join(home, ".git"));
    writeFileSync(join(home, "notes", "trip.md"), "x");
    writeFileSync(join(home, "plan.md"), "x");
    writeFileSync(join(home, ".git", "index"), "x");
    writeFileSync(join(home, "old.md"), "x");
    const sec = (ms: number) => ms / 1000;
    utimesSync(join(home, "old.md"), sec(now - 3 * HOUR), sec(now - 3 * HOUR));
    utimesSync(join(home, "plan.md"), sec(now - HOUR), sec(now - HOUR));
    utimesSync(join(home, "notes", "trip.md"), sec(now - 60_000), sec(now - 60_000));
    const files = recentFiles(home, now - 2 * HOUR);
    expect(files).toEqual([join("notes", "trip.md"), "plan.md"]);
  });

  it("builds separate blocks and ends where the new input goes", () => {
    const now = Date.now();
    writeFileSync(join(home, "MEMORY.md"), "# Alex\n\n- Saturday hike: ridge route\n");
    const a = inbound(chat, "Which route on Saturday?", now - 3 * HOUR);
    const sent = store.insertOutbound({ chatId: chat.id, body: "The ridge route.", replyTo: a.id });
    store.setOutboundResult(sent.id, "sent", "p-out");
    const failed = store.insertOutbound({ chatId: chat.id, body: "never arrived", replyTo: null });
    store.setOutboundResult(failed.id, "failed", null);
    inbound(chat, "someone else's chatter", now - 2 * HOUR, false);
    const dmMessage = inbound(dm, "Bring water?", now - HOUR);
    const trigger = inbound(chat, "What time do we meet?", now);

    const text = buildColdContext({
      store,
      agentId,
      agentName: "Alex",
      homeDir: home,
      actions: Array.from({ length: 20 }, (_, i) => ({ at: now - 1000 * (20 - i), text: `Bash: step ${i}` })),
      exclude: [trigger.id],
      now,
    });
    const order = [
      "## MEMORY.md",
      "- Saturday hike: ridge route",
      "## Latest messages",
      `msg=${a.id}`,
      `msg=${dmMessage.id}`,
      // Sent now, by the store's clock: the newest.
      `msg=${sent.id}`,
      "## Files in your home folder",
      "## Your last actions",
      "## New input",
    ].map((part) => text.indexOf(part));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] as number)))).toBe(true);
    expect(text).toContain('from="Alex" you');
    expect(text).not.toContain(trigger.id);
    expect(text).not.toContain("never arrived");
    expect(text).not.toContain("someone else's chatter");
    // The last 15 actions only.
    expect(text).not.toContain("Bash: step 4\n");
    expect(text).toContain("Bash: step 5");
    expect(text).toContain("Bash: step 19");
    // An ordinary briefing: no word of a reset, and no request for a summary.
    expect(text).not.toMatch(/reset|new session|fresh session|summar/i);
  });

  it.each(["pause", "ignore"] as const)("excludes ignored messages produced by %s before limiting history", (mode) => {
    const now = Date.now();
    const kept = inbound(dm, "Keep this conversation", now - 60_000);
    store.moveInbound([kept.id], "deliver", "prior-turn");
    store.moveInbound([kept.id], "reply");
    for (let i = 0; i < 30; i++) {
      const ignored = inbound(dm, `Discarded request ${i}`, now - 1000 + i);
      if (mode === "ignore") store.moveInbound([ignored.id], "fail");
      store.moveInbound([ignored.id], mode);
      expect(store.message(ignored.id)?.state).toBe("ignored");
    }
    expect(store.recentConversation(agentId, 1).map((m) => m.id)).toEqual([kept.id]);
    const text = buildColdContext({ store, agentId, agentName: "Alex", homeDir: home, actions: [], exclude: [], now });
    expect(text).toContain(kept.body);
    expect(text).not.toContain("Discarded request");
  });

  it("keeps only the latest 25 messages and leaves out empty blocks", () => {
    const now = Date.now();
    for (let i = 0; i < 30; i++) inbound(dm, `message ${i}`, now - (30 - i) * 1000);
    const text = buildColdContext({
      store,
      agentId,
      agentName: "Alex",
      homeDir: join(home, "missing"),
      actions: [],
      exclude: [],
      now,
    });
    expect(text.match(/\[msg=/g)).toHaveLength(25);
    const big = inbound(dm, "x".repeat(5000), now);
    const cut = buildColdContext({ store, agentId, agentName: "Alex", homeDir: home, actions: [], exclude: [], now });
    expect(cut).toContain(`[cut here; the full text: "$MINGLE_CLI" message read ${dm.id} --around ${big.id}]`);
    expect(cut).not.toContain("x".repeat(1201));
    expect(text).not.toContain("message 4\n");
    expect(text).toContain("message 5");
    expect(text).not.toContain("## MEMORY.md");
    expect(text).not.toContain("## Your last actions");
    expect(
      buildColdContext({
        store,
        agentId: "nobody",
        agentName: "X",
        homeDir: join(home, "missing"),
        actions: [],
        exclude: [],
        now,
      }),
    ).toBe("");
  });
});

describe("cold start in the runtime", () => {
  let home: string;
  let store: Store;
  let agentId: string;
  let chat: Chat;
  let clock: number;
  let turns: { input: string; resume: string | undefined; steered: string[] }[];
  let hold: Promise<void> | undefined;
  let logs: string[];
  let runtime: AgentRuntime;
  let seq = 0;

  const start = (rebuild: boolean) => {
    const scripted = scriptedRuntime({
      turn: async (t: ScriptedTurn) => {
        const record = { input: t.input, resume: (t.options as { resume?: string }).resume, steered: [] as string[] };
        turns.push(record);
        await t.tool("Bash", '{"command":"ls notes"}');
        if (hold) await hold;
        record.steered = [...t.steered];
        // The agent answers what it was given, so Mingle has nothing to nudge about.
        for (const id of messageIds([t.input, ...t.steered].join("\n"))) store.moveInbound([id], "reply");
        t.say("ok");
      },
    });
    runtime = new AgentRuntime(agentId, {
      store,
      harness: oarHarness({ require: () => scripted }),
      homeDir: home,
      env: () => ({}),
      signIn: () => "scripted",
      limitRevision: () => undefined,
      onSession: () => {},
      coalesceMs: 5,
      now: () => clock,
      // The scripted runtime counts about a token per four characters: a small floor stands in for 128K.
      coldStart: { rebuild, policy: { idleMs: HOUR, minTokens: 50 } },
      log: (line) => logs.push(line),
    });
    runtime.start();
  };

  const send = (body: string) => {
    const message = store.insertInbound({
      chatId: chat.id,
      platformId: String(++seq),
      senderId: "u1",
      senderName: "Zhang San",
      body,
      attachments: [],
      replyTo: null,
      triggers: true,
      createdAt: clock,
    });
    if (!message) throw new Error("not stored");
    runtime.enqueueMessage(message.id);
    return message;
  };

  const settled = async (count: number) => {
    await until(() => turns.length >= count);
    await until(() => store.agent(agentId)?.status === "idle" && !runtime.busy);
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mingle-cold-rt-"));
    store = new Store(`${home}.db`);
    agentId = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" }).id;
    const connection = store.createConnection({ agentId, platform: "telegram", secretRef: "s" });
    chat = store.upsertChat({ connectionId: connection.id, platformId: "-100", kind: "group", name: "Hikes" });
    writeFileSync(join(home, "MEMORY.md"), "# Alex\n\n- Saturday hike: ridge route\n");
    clock = Date.now();
    turns = [];
    hold = undefined;
    logs = [];
  });

  afterEach(async () => {
    await runtime.dispose();
    store.close();
    rmSync(home, { recursive: true, force: true });
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${home}.db${suffix}`, { force: true });
  });

  const long = "Which route should we take on Saturday? ".repeat(20);

  it("opens a fresh session with a built context after a long idle", async () => {
    start(true);
    const first = send(long);
    await settled(1);
    const oldSession = store.agent(agentId)?.sessionId;
    expect(oldSession).toBeTruthy();

    clock += 2 * HOUR;
    const second = send("What time do we meet?");
    await settled(2);

    const input = turns[1]?.input ?? "";
    expect(turns[1]?.resume).toBeUndefined();
    expect(input).toContain("- Saturday hike: ridge route");
    expect(input).toContain(`msg=${first.id}`);
    expect(input).toContain("Bash: ls notes");
    // The input that woke the agent comes last, once.
    expect(input.indexOf(`msg=${second.id}`)).toBeGreaterThan(input.indexOf("## New input"));
    expect(input.split(`msg=${second.id}`)).toHaveLength(2);
    const agent = store.agent(agentId);
    expect(agent?.sessionId).not.toBe(oldSession);
    expect(store.previousSessionId(agentId)).toBe(oldSession);
    await until(() => logs.some((l) => l.includes("cold turn mode=rebuild")));
  });

  it("keeps the warm session when the idle was short", async () => {
    start(true);
    send(long);
    await settled(1);
    const session = store.agent(agentId)?.sessionId;
    clock += 30 * 60_000;
    send("What time do we meet?");
    await settled(2);
    expect(turns[1]?.input).not.toContain("## New input");
    expect(store.agent(agentId)?.sessionId).toBe(session);
    expect(store.previousSessionId(agentId)).toBeNull();
  });

  it("keeps the session when the context is small", async () => {
    start(true);
    send("Hi");
    await settled(1);
    const session = store.agent(agentId)?.sessionId;
    clock += 2 * HOUR;
    send("Still there?");
    await settled(2);
    expect(turns[1]?.input).not.toContain("## New input");
    expect(store.agent(agentId)?.sessionId).toBe(session);
  });

  it("resumes when the flag is off, and still measures the cold turn", async () => {
    start(false);
    send(long);
    await settled(1);
    const session = store.agent(agentId)?.sessionId;
    clock += 2 * HOUR;
    send("What time do we meet?");
    await settled(2);
    expect(turns[1]?.input).not.toContain("## New input");
    expect(store.agent(agentId)?.sessionId).toBe(session);
    await until(() => logs.some((l) => /cold turn mode=resume idle=120m context=\d+/.test(l)));
  });

  it("steers an interjection into the running turn instead of starting over", async () => {
    start(true);
    send(long);
    await settled(1);
    let release = () => {};
    hold = new Promise((r) => {
      release = r;
    });
    clock += 2 * HOUR;
    // Cold: this one opens a fresh session, and its turn is held open.
    send("What time do we meet?");
    await until(() => turns.length >= 2 && runtime.busy);
    const session = store.agent(agentId)?.sessionId;
    clock += 2 * HOUR;
    const interjection = send("And bring water?");
    await until(() => store.message(interjection.id)?.state === "delivered");
    release();
    await settled(2);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.steered.join("\n")).toContain(`msg=${interjection.id}`);
    expect(turns[1]?.steered.join("\n")).not.toContain("## New input");
    expect(store.agent(agentId)?.sessionId).toBe(session);
  });
});
