import { afterEach, describe, expect, it } from "vitest";
import { FINAL_INBOUND, INBOUND, type InboundEvent, nextInbound } from "../src/core/inbound.ts";
import { type InboundState, Store } from "../src/store/store.ts";
import { driveInbound, type Rig, rig, until } from "./helpers.ts";

const STATES: readonly InboundState[] = ["received", "delivered", "replied", "unanswered", "failed", "ignored"];
const EVENTS = Object.keys(INBOUND) as InboundEvent[];

describe("inbound message state machine", () => {
  it("never leaves a final state", () => {
    for (const state of FINAL_INBOUND) {
      for (const event of EVENTS) expect(nextInbound(state, event)).toBeUndefined();
    }
  });

  it("gives every other state a way out", () => {
    for (const state of STATES.filter((s) => !FINAL_INBOUND.includes(s))) {
      expect(EVENTS.some((event) => nextInbound(state, event) !== undefined)).toBe(true);
    }
    // What waits on the owner can always be retried or dismissed from the console.
    for (const state of ["failed", "unanswered"] as const) {
      expect(nextInbound(state, "retry")).toBe("received");
      expect(nextInbound(state, "ignore")).toBe("ignored");
    }
  });

  it("answers a failed message only when the reply quotes it", () => {
    expect(nextInbound("failed", "reply")).toBe("replied");
    expect(nextInbound("failed", "send")).toBeUndefined();
    // A plain send answers only what the agent has seen.
    expect(nextInbound("received", "send")).toBeUndefined();
    expect(nextInbound("delivered", "send")).toBe("replied");
    expect(nextInbound("unanswered", "send")).toBe("replied");
  });

  it("drops what a paused agent had not answered, and leaves what waits on the owner", () => {
    expect(nextInbound("received", "pause")).toBe("ignored");
    expect(nextInbound("delivered", "pause")).toBe("ignored");
    expect(nextInbound("failed", "pause")).toBeUndefined();
    expect(nextInbound("unanswered", "pause")).toBeUndefined();
  });
});

describe("concurrent inbound events", () => {
  let store: Store;
  let chatId: string;
  let seq = 0;
  afterEach(() => store.close());

  const setup = () => {
    store = new Store(":memory:");
    const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
    const connection = store.createConnection({ agentId: agent.id, platform: "telegram", secretRef: "s1" });
    chatId = store.upsertChat({ connectionId: connection.id, platformId: "1", kind: "dm" }).id;
  };
  const message = (state: InboundState) => {
    const inserted = store.insertInbound({
      chatId,
      platformId: `p${++seq}`,
      senderId: "u1",
      senderName: "Zhang San",
      body: "hi",
      attachments: [],
      replyTo: null,
      triggers: true,
      createdAt: Date.now() + seq,
    });
    if (!inserted) throw new Error("insert failed");
    driveInbound(store, inserted.id, state);
    return inserted.id;
  };
  const run = (start: InboundState, events: readonly InboundEvent[]) => {
    const id = message(start);
    for (const event of events) store.moveInbound([id], event);
    return store.message(id)?.state;
  };

  it.each([
    // Retry, ignore and a late reply, each pair in both orders: the first to land wins
    // unless the second is a legal next step from where the first left the message.
    { start: "failed", events: ["retry", "ignore"], end: "received" },
    { start: "failed", events: ["ignore", "retry"], end: "ignored" },
    { start: "failed", events: ["retry", "reply"], end: "replied" },
    { start: "failed", events: ["reply", "retry"], end: "replied" },
    { start: "failed", events: ["ignore", "reply"], end: "ignored" },
    { start: "failed", events: ["reply", "ignore"], end: "replied" },
    { start: "unanswered", events: ["retry", "ignore"], end: "received" },
    { start: "unanswered", events: ["ignore", "retry"], end: "ignored" },
    { start: "unanswered", events: ["retry", "send"], end: "received" },
    { start: "unanswered", events: ["send", "retry"], end: "replied" },
    { start: "unanswered", events: ["ignore", "reply"], end: "ignored" },
    { start: "unanswered", events: ["reply", "ignore"], end: "replied" },
    // A retried message redelivered and then answered.
    { start: "failed", events: ["retry", "deliver", "reply"], end: "replied" },
    // The agent answers a retried message before it is delivered again: delivery must not undo it.
    { start: "failed", events: ["retry", "reply", "deliver"], end: "replied" },
    // A fast reply, then the turn fails or ends: the reply stands.
    { start: "delivered", events: ["reply", "fail"], end: "replied" },
    { start: "delivered", events: ["reply", "give_up"], end: "replied" },
    { start: "delivered", events: ["give_up", "fail"], end: "unanswered" },
  ] as const)("$start + $events → $end", ({ start, events, end }) => {
    setup();
    expect(run(start, events)).toBe(end);
  });

  it("leaves final messages alone whatever arrives late", () => {
    setup();
    for (const start of FINAL_INBOUND) {
      for (const event of EVENTS) {
        const id = message(start);
        expect(store.moveInbound([id], event)).toEqual([]);
        expect(store.message(id)?.state).toBe(start);
      }
    }
  });

  it("moves only inbound messages, and reports which ones moved", () => {
    setup();
    const failed = message("failed");
    const received = message("received");
    const outbound = store.insertOutbound({ chatId, body: "out", replyTo: null });
    store.setOutboundResult(outbound.id, "failed", null);
    expect(store.moveInbound([failed, received, outbound.id, "m_nope"], "retry")).toEqual([failed]);
    expect(store.message(outbound.id)?.state).toBe("failed");
  });

  it("clears the nudge on retry, so the message is nudged again", () => {
    setup();
    const id = message("delivered");
    store.markNudged([id]);
    store.moveInbound([id], "give_up");
    store.moveInbound([id], "retry");
    expect(store.wasNudged(id)).toBe(false);
  });

  it("clears the nudge when a waiting message resumes, so it is nudged again", () => {
    setup();
    const id = message("delivered");
    store.markNudged([id]);
    store.moveInbound([id], "hold", undefined, Date.now() + 60_000);
    store.moveInbound([id], "resume");
    expect(store.wasNudged(id)).toBe(false);
  });
});

describe("inbound state in a running Mingle", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  it("does not deliver a retried message again once it was answered", async () => {
    // The agent never answers on its own, so the message ends up unanswered.
    current = await rig(async () => {}, { coalesceMs: 300 });
    const { mingle, agentId, channel, admin } = current;
    const inbound = channel.receive({ text: "are we still on for Saturday?" });
    const chat = await until(() => mingle.store.agentChats(agentId)[0]?.id);
    const id = await until(() => {
      const stored = mingle.store.messageByPlatformId(chat, inbound.platformId);
      return stored?.state === "unanswered" && stored.id;
    });
    const turns = current.turns.length;

    const retried = await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [id] });
    expect(retried.json).toEqual({ retried: [id], offline: [] });
    // The agent answers (say, from history) before the retry is delivered.
    expect(mingle.store.moveInbound([id], "reply")).toEqual([id]);
    // Retry and ignore after that change nothing.
    expect((await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [id] })).json).toEqual({
      retried: [],
      offline: [],
    });
    expect((await admin("POST", `/v1/admin/agents/${agentId}/messages/ignore`, { ids: [id] })).json).toEqual({
      ignored: [],
    });

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(current.turns.length).toBe(turns);
    expect(mingle.store.message(id)?.state).toBe("replied");
  });
});
