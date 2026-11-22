import { afterEach, describe, expect, it, vi } from "vitest";
import { eventually, messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/**
 * How a group wakes the agent beyond @-mentions (docs/spec.md 4.2): a group the owner set to hear
 * everything, and threads that are one conversation.
 */
describe("a group that hears everything", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const hearing = { quietMs: 150, maxWaitMs: 2_000, gapMs: 0 };
  /** A person's turn ends within a quarter second here, so the fast lane is fast in test time too. */
  const engage = {
    turnEnd: { k: 2, minMs: 100, maxMs: 300, defaultMs: 200, samples: 20, gapCapMs: 30_000 },
    fastMaxWaitMs: 1_000,
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let env: Record<string, string> = {};

  /** The agent answers what is addressed to it; what it only heard, it leaves be unless `speak`. */
  async function setup(
    options: {
      speak?: boolean;
      hearing?: typeof hearing;
      heard?: (chat: string) => Promise<void>;
      log?: (line: string) => void;
    } = {},
  ) {
    current = await rig(
      async (t) => {
        env = t.options.env as Record<string, string>;
        if (t.input.includes("[mingle] Heard in")) {
          if (options.heard) await options.heard(/Heard in (c\w+)/.exec(t.input)?.[1] as string);
          if (options.speak) {
            const chat = /Heard in (c\w+)/.exec(t.input)?.[1] as string;
            await runCli(env, ["message", "send", "--to", chat], "I know a shorter route.");
          }
          return;
        }
        for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
      },
      { hearing: options.hearing ?? hearing, engage, ...(options.log ? { log: options.log } : {}) },
    );
    return current;
  }

  /** A group set to hear only what is addressed to the agent, for each test to turn on when it needs to. */
  async function groupOf(r: Rig): Promise<string> {
    r.channel.receive({ text: "hi all", addressedToBot: false });
    const chat = await until(() => r.mingle.store.agentChats(r.agentId)[0]);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat.id}/listen`, { listen: false });
    return chat.id;
  }

  it("hears a new group by default", async () => {
    const r = await setup();
    r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
    await until(() => r.turns.length === 1);
    expect(r.turns[0]?.input).toMatch(/^\[mingle\] Heard in c\w+: 1 message said there/);
    const chat = r.mingle.store.agentChats(r.agentId)[0]?.id as string;
    const conversations = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/conversations`)).json as {
      chat: { id: string };
      listen: boolean | null;
    }[];
    expect(conversations.find((c) => c.chat.id === chat)?.listen).toBe(true);
  });

  it("does not hear a new group the owner has not let in", async () => {
    current = await rig(async () => {}, { hearing, trust: "public" });
    const r = current;
    r.channel.receive({ text: "free airdrop, click here", addressedToBot: false });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(r.turns).toHaveLength(0);
  });

  it("keeps the rest of a group as background once the owner turns hearing off", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
    await sleep(500);
    expect(r.turns).toHaveLength(0);
    const conversations = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/conversations`)).json as {
      chat: { id: string };
      listen: boolean | null;
    }[];
    expect(conversations.find((c) => c.chat.id === chat)?.listen).toBe(false);
  });

  it("hands over a stretch once the group is quiet, which the agent may leave unanswered", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    expect((await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true })).status).toBe(
      200,
    );
    r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
    r.channel.receive({
      text: "8 is early, 9?",
      addressedToBot: false,
      sender: { id: "u2", name: "Li Si", isBot: false },
    });
    await until(() => r.turns.length === 1);
    const input = r.turns[0]?.input ?? "";
    expect(input).toMatch(/^\[mingle\] Heard in c\w+: 2 messages said there, none addressed to you\./);
    expect(input).toContain("shall we start at 8?");
    expect(input).toContain("8 is early, 9?");
    // Said before the group was set to hear everything: not handed over.
    expect(input).not.toContain("hi all");
    // Nothing to answer: no reminder to reply, nothing for the owner, nothing sent.
    await sleep(500);
    expect(r.turns).toHaveLength(1);
    expect(r.channel.sent).toHaveLength(0);
    expect(r.mingle.store.chatMessages(chat, 10).every((m) => m.state === "ignored")).toBe(true);
    const listed = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/conversations`)).json as {
      listen: boolean | null;
    }[];
    expect(listed[0]?.listen).toBe(true);
  });

  it("lets the agent speak up, and starts the next stretch after what it said", async () => {
    const r = await setup({ speak: true });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "which way to the top?", addressedToBot: false });
    await until(() => r.channel.sent.length === 1);
    expect(r.channel.sent[0]?.text).toBe("I know a shorter route.");
    r.channel.receive({ text: "great, thanks", addressedToBot: false });
    await until(() => r.turns.length === 2);
    expect(r.turns[1]?.input).toContain("great, thanks");
    expect(r.turns[1]?.input).not.toContain("which way to the top?");
  });

  it("says how many earlier messages a long stretch leaves out, and where to read them", async () => {
    const r = await setup({ hearing: { quietMs: 400, maxWaitMs: 5_000, gapMs: 0 } });
    for (let i = 1; i <= 33; i++) r.channel.receive({ text: `line ${i}`, addressedToBot: false });
    await until(() => r.turns.length === 1);
    const input = r.turns[0]?.input ?? "";
    const hint =
      /: 30 messages said there, none addressed to you\. 3 earlier messages are not shown: `message read c\w+ --before (m\w+)`\./.exec(
        input,
      );
    expect(hint).not.toBeNull();
    // The hint points at the oldest message shown: what came before it is what was left out.
    expect(r.mingle.store.message(hint?.[1] as string)?.body).toBe("line 4");
    expect(input).not.toMatch(/line 3$/m);
  });

  it("logs where the time of a stretch went once its turn ends", async () => {
    const lines: string[] = [];
    const r = await setup({ speak: true, log: (line) => lines.push(line) });
    r.channel.receive({ text: "which way to the top?", addressedToBot: false });
    await until(() => lines.some((l) => l.includes(": heard c")));
    expect(lines.find((l) => l.includes(": heard c"))).toMatch(
      /: heard c\w+ slow: 1 message from 1 person \(0 engaged\), first \+0s, last \+0s, handed over \+\d+s, turn \+\d+s, spoke \+\d+s, last spoke \+\d+s, cues 0$/,
    );
  });

  it("keeps up with someone it is in a conversation with, without the gap between stretches", async () => {
    const lines: string[] = [];
    // A gap of a minute: only the fast lane can hand the second stretch over within the test.
    const r = await setup({
      speak: true,
      hearing: { quietMs: 150, maxWaitMs: 2_000, gapMs: 60_000 },
      log: (line) => lines.push(line),
    });
    r.channel.receive({ text: "which way to the top?", addressedToBot: false });
    await until(() => r.channel.sent.length === 1);
    await until(() => lines.some((l) => / heard c\w+ slow: /.test(l)));
    // The agent answered them: what they say next is meant for it, and reaches it at their pace.
    r.channel.receive({ text: "and how long does it take?", addressedToBot: false });
    await until(() => r.turns.length === 2, 5_000);
    expect(r.turns[1]?.input).toContain("and how long does it take?");
    await until(() => lines.some((l) => / heard c\w+ fast: /.test(l)));
  });

  it("lets others ride along while someone is in a conversation, and goes fast for its name", async () => {
    const r = await setup({ speak: true, hearing: { quietMs: 150, maxWaitMs: 2_000, gapMs: 60_000 } });
    const alex = r.mingle.store.agent(r.agentId)?.name as string;
    r.channel.receive({
      text: `${alex}, which way to the top?`,
      addressedToBot: false,
      sender: { id: "u9", name: "Wang Fang", isBot: false },
    });
    // Called by name with no gap behind it: fast from the first line.
    await until(() => r.turns.length === 1, 5_000);
    await until(() => r.channel.sent.length === 1);
    r.channel.receive({
      text: "lunch anyone?",
      addressedToBot: false,
      sender: { id: "u2", name: "Li Si", isBot: false },
    });
    await sleep(600);
    // Chatter does not get a turn of its own while Wang Fang is in a conversation with the agent.
    expect(r.turns).toHaveLength(1);
    r.channel.receive({
      text: "is it steep?",
      addressedToBot: false,
      sender: { id: "u9", name: "Wang Fang", isBot: false },
    });
    await until(() => r.turns.length === 2, 5_000);
    // It rides along with her next stretch, hers first.
    const input = r.turns[1]?.input ?? "";
    expect(input).toContain("is it steep?");
    expect(input).toContain("lunch anyone?");
  });

  it("does not start a stretch for another bot", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "deploy failed", addressedToBot: false, sender: { id: "b9", name: "Bob", isBot: true } });
    await sleep(500);
    expect(r.turns).toHaveLength(0);
  });

  it("drops the waiting stretch when someone @s the agent meanwhile", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
    r.channel.receive({ text: "@alex what do you think?" });
    await until(() => r.turns.length === 1);
    await sleep(500);
    expect(r.turns).toHaveLength(1);
    // The @ came as a message to answer, with what was said before it counted as unseen.
    expect(r.turns[0]?.input).toMatch(/unseen=\d+/);
    expect(r.turns[0]?.input).not.toContain("[mingle] Heard in");
  });

  it("waits out the gap between stretches, and stops when turned off", async () => {
    const r = await setup({ hearing: { quietMs: 100, maxWaitMs: 2_000, gapMs: 1_000 } });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "one", addressedToBot: false });
    await until(() => r.turns.length === 1);
    const first = Date.now();
    r.channel.receive({ text: "two", addressedToBot: false });
    await until(() => r.turns.length === 2);
    expect(Date.now() - first).toBeGreaterThanOrEqual(800);
    expect(r.turns[1]?.input).toContain("two");
    expect(r.turns[1]?.input).not.toContain("one\n");

    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: false });
    r.channel.receive({ text: "three", addressedToBot: false });
    await sleep(1_300);
    expect(r.turns).toHaveLength(2);
  });

  type View = {
    pace: string;
    everyMs?: number;
    slowedMs?: number;
    tier: string | null;
    defaultTier: string;
    live: string[];
    aliases: string[];
  };
  type Listed = { chat: { id: string }; hearing: View | null }[];
  const viewOf = async (r: Rig, chat: string) =>
    ((await r.admin("GET", `/v1/admin/agents/${r.agentId}/conversations`)).json as Listed).find(
      (c) => c.chat.id === chat,
    )?.hearing;
  /** The pace part of a group's hearing, as the agent set it. */
  const hearingOf = async (r: Rig, chat: string) => {
    const view = await viewOf(r, chat);
    if (!view) return view;
    const { pace, everyMs, slowedMs } = view;
    return {
      pace,
      ...(everyMs !== undefined ? { everyMs } : {}),
      ...(slowedMs !== undefined ? { slowedMs } : {}),
    };
  };

  it("lets the agent mute a group until someone addresses it there", async () => {
    let muted: { code: number; stdout: string } | undefined;
    const r = await setup({
      heard: async (chat) => {
        muted ??= await runCli(env, ["chat", "hear", chat, "--mute"]);
      },
    });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "lunch?", addressedToBot: false });
    await until(() => muted);
    expect(muted?.code).toBe(0);
    expect(muted?.stdout).toContain("you hear nothing said here until someone @-mentions you");
    expect(await hearingOf(r, chat)).toEqual({ pace: "muted" });
    // Muted: what is said is kept, and does not reach the agent.
    r.channel.receive({ text: "pizza again", addressedToBot: false });
    await sleep(500);
    expect(r.turns).toHaveLength(1);
    expect(r.mingle.store.chatMessages(chat, 10).some((m) => m.body === "pizza again")).toBe(true);
    // Addressed: the mute is over, the agent hears so with the message, and hears everything again.
    r.channel.receive({ text: "@alex what do you think?" });
    await until(() => r.turns.length === 2);
    expect(r.turns[1]?.input).toContain(`[mingle] Someone in ${chat} addressed you, so the mute you set there is over`);
    expect(await hearingOf(r, chat)).toEqual({ pace: "auto" });
    await until(() => r.channel.sent.length === 1);
    r.channel.receive({ text: "back to lunch", addressedToBot: false });
    await until(() => r.turns.length === 3);
    expect(r.turns[2]?.input).toContain("[mingle] Heard in");
  });

  it("lets the agent hear a group less often, within bounds, and the owner put it back", async () => {
    const results: { code: number; stdout: string; stderr: string }[] = [];
    const r = await setup({
      heard: async (chat) => {
        if (results.length > 0) return;
        results.push(await runCli(env, ["chat", "hear", chat, "--every", "1m"]));
        results.push(await runCli(env, ["chat", "hear", chat, "--every", "8d"]));
        results.push(await runCli(env, ["chat", "hear", chat, "--every", "7d"]));
        results.push(await runCli(env, ["chat", "hear", chat, "--every", "2h"]));
        results.push(await runCli(env, ["chat", "info", chat]));
      },
    });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "one", addressedToBot: false });
    await until(() => results.length === 5);
    expect(results[0]?.code).not.toBe(0);
    expect(results[0]?.stderr).toContain("every_out_of_range");
    expect(results[1]?.stderr).toContain("every_out_of_range");
    expect(results[2]?.stdout).toContain("at most once every 7d");
    expect(results[3]?.stdout).toContain("at most once every 2h");
    expect(results[4]?.stdout).toContain("hears everything: you hear what was said here at most once every 2h");
    expect(await hearingOf(r, chat)).toEqual({ pace: "every", everyMs: 2 * 3_600_000 });
    // Not again within two hours.
    r.channel.receive({ text: "two", addressedToBot: false });
    await sleep(600);
    expect(r.turns).toHaveLength(1);
    // The owner puts it back on the usual pace: what waited comes at that pace, no longer two hours on.
    expect((await r.admin("DELETE", `/v1/admin/agents/${r.agentId}/chats/${chat}/hearing`)).json).toMatchObject({
      pace: "auto",
    });
    await until(() => r.turns.length === 2);
    expect(r.turns[1]?.input).toContain("two");
  });

  it("does not let the agent set a pace where the owner did not turn hearing on", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    r.channel.receive({ text: "@alex hi" });
    await until(() => r.turns.length === 1);
    const refused = await runCli(env, ["chat", "hear", chat, "--mute"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("not_hearing");
    expect(await hearingOf(r, chat)).toBeNull();
  });

  it("hears a group less often while the agent leaves stretch after stretch unanswered", async () => {
    const r = await setup({ hearing: { quietMs: 50, maxWaitMs: 2_000, gapMs: 150 } });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    const at: number[] = [];
    for (let i = 0; i < 5; i++) {
      r.channel.receive({ text: `chatter ${i}`, addressedToBot: false });
      await until(() => r.turns.length === i + 1);
      at.push(Date.now());
    }
    // Three unanswered at the usual gap, then twice it, then four times.
    expect((at[3] as number) - (at[2] as number)).toBeGreaterThanOrEqual(250);
    expect((at[4] as number) - (at[3] as number)).toBeGreaterThanOrEqual(550);
    expect((await hearingOf(r, chat))?.slowedMs).toBe(150 * 2 ** 3);
    // Someone addressing it brings the usual pace back.
    r.channel.receive({ text: "@alex still there?" });
    await until(() => r.turns.length === 6);
    expect(await hearingOf(r, chat)).toEqual({ pace: "auto" });
  });

  it("forgets the agent's pace when the owner turns hearing off", async () => {
    const r = await setup({
      heard: async (chat) => {
        await runCli(env, ["chat", "hear", chat, "--mute"]);
      },
    });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "one", addressedToBot: false });
    await until(() => r.mingle.store.chat(chat)?.hearPace.kind === "muted");
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: false });
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    expect(await hearingOf(r, chat)).toEqual({ pace: "auto" });
  });

  it("lets the owner pick how fast a group keeps up, or leave it to the group's size", async () => {
    const r = await setup();
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    // One person has spoken there: a small group, fast by default.
    expect(await viewOf(r, chat)).toMatchObject({ tier: null, defaultTier: "fast", live: [], aliases: [] });
    const path = `/v1/admin/agents/${r.agentId}/chats/${chat}/hearing`;
    expect((await r.admin("PUT", path, { tier: "save" })).json).toMatchObject({ tier: "save", defaultTier: "fast" });
    expect(r.mingle.store.chat(chat)?.hearTier).toBe("save");
    const bad = await r.admin("PUT", path, { tier: "turbo" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.json)).toContain("tier_invalid");
    expect((await r.admin("PUT", path, { tier: null })).json).toMatchObject({ tier: null });
    // A body of JSON null is a bad request, not a crash.
    expect((await r.admin("PUT", path, null)).status).toBe(400);
    expect((await r.admin("POST", `/v1/admin/agents/${r.agentId}/chats/${chat}/aliases`, null)).status).toBe(400);
  });

  it("takes another name as a call, from the owner or the agent, and keeps it when hearing goes off", async () => {
    const results: { code: number; stdout: string; stderr: string }[] = [];
    const r = await setup({
      speak: true,
      hearing: { quietMs: 150, maxWaitMs: 2_000, gapMs: 60_000 },
      heard: async (chat) => {
        if (results.length > 0) return;
        results.push(await runCli(env, ["chat", "alias", chat, "add", "trail", "buddy"]));
        results.push(await runCli(env, ["chat", "alias", chat, "add", "x"]));
        results.push(await runCli(env, ["chat", "alias", chat, "add", "Alex"]));
        results.push(await runCli(env, ["chat", "info", chat]));
      },
    });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "lunch anyone?", addressedToBot: false });
    await until(() => results.length === 4);
    expect(results[0]?.stdout).toContain("also called trail buddy");
    expect(results[1]?.stderr).toContain("alias_invalid");
    // Its own name always counts: not stored again.
    expect(results[2]?.stdout).toContain("also called trail buddy");
    expect(results[3]?.stdout).toContain("keeps up with a conversation: fast, by the group's size");
    expect(results[3]?.stdout).toContain("also called here: trail buddy");
    await until(() => r.turns.length === 1);
    // Called by that name, past the gap of a minute: fast.
    r.channel.receive({
      text: "Trail Buddy, which way?",
      addressedToBot: false,
      sender: { id: "u9", name: "Wang Fang", isBot: false },
    });
    await until(() => r.turns.length === 2, 5_000);
    expect(r.turns[1]?.input).toContain("You are in a conversation here with");
    // The owner adds and removes one name at a time, on the list as it is now: a name the agent added
    // since the console last looked is kept.
    const path = `/v1/admin/agents/${r.agentId}/chats/${chat}/aliases`;
    await runCli(env, ["chat", "alias", chat, "add", "guide"]);
    expect((await r.admin("POST", path, { alias: " 向导 " })).json).toMatchObject({
      aliases: ["trail buddy", "guide", "向导"],
    });
    expect((await r.admin("DELETE", path, { alias: "trail buddy" })).json).toMatchObject({
      aliases: ["guide", "向导"],
    });
    for (let i = 0; i < 6; i++) await r.admin("POST", path, { alias: `name ${i}` });
    const many = await r.admin("POST", path, { alias: "one too many" });
    expect(JSON.stringify(many.json)).toContain("too_many_aliases");
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: false });
    expect(r.mingle.store.chat(chat)?.aliases).toHaveLength(8);
    const removed = await runCli(env, ["chat", "alias", chat, "remove", "guide"]);
    expect(removed.stdout).toContain("also called 向导");
  });

  it("hears a line said while it was still answering the last stretch", async () => {
    let rig: Rig | undefined;
    let once = false;
    rig = await setup({
      speak: true,
      hearing: { quietMs: 150, maxWaitMs: 2_000, gapMs: 800 },
      heard: async () => {
        if (once) return;
        once = true;
        // Said after the stretch was handed over and before the agent's answer went out; its own
        // stretch is handed over after that answer, past the gap.
        // From someone else, so it is not steered into the running turn.
        rig?.channel.receive({
          text: "and bring water?",
          addressedToBot: false,
          sender: { id: "u9", name: "Wang Fang", isBot: false },
        });
        await sleep(200);
      },
    });
    const r = rig;
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "which way to the top?", addressedToBot: false });
    await until(() => r.turns.length === 2, 5_000);
    expect(r.turns[1]?.input).toContain("and bring water?");
    expect(r.turns[1]?.input).not.toContain("which way to the top?");
  });

  it("times what waits again when the pace gets shorter", async () => {
    let set: { code: number } | undefined;
    const r = await setup({
      hearing: { quietMs: 150, maxWaitMs: 2_000, gapMs: 600 },
      heard: async (chat) => {
        set ??= await runCli(env, ["chat", "hear", chat, "--every", "1h"]);
      },
    });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "which way to the top?", addressedToBot: false });
    await until(() => r.turns.length === 1 && set?.code === 0);
    // Waits for the hour the agent chose...
    r.channel.receive({ text: "anyone?", addressedToBot: false });
    await sleep(1_000);
    expect(r.turns).toHaveLength(1);
    // ...until the owner puts the usual pace back: then it comes at that pace, with no new message.
    await r.admin("DELETE", `/v1/admin/agents/${r.agentId}/chats/${chat}/hearing`);
    await until(() => r.turns.length === 2, 3_000);
    expect(r.turns[1]?.input).toContain("anyone?");
  });

  it("says whom it is in a conversation with", async () => {
    const r = await setup({ speak: true, hearing: { quietMs: 150, maxWaitMs: 2_000, gapMs: 60_000 } });
    const chat = await groupOf(r);
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${chat}/listen`, { listen: true });
    r.channel.receive({ text: "which way to the top?", addressedToBot: false });
    await until(() => r.channel.sent.length === 1);
    await eventually(async () => (await viewOf(r, chat))?.live.length === 1);
    expect((await viewOf(r, chat))?.live).toEqual(["Zhang San"]);
  });

  it("lets go of a stretch it was about to hear when it stops", async () => {
    const r = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      r.channel.receive({ text: "shall we start at 8?", addressedToBot: false });
      expect(vi.getTimerCount()).toBe(1);
      // Stopping lets go of the waiting stretch; a message arriving meanwhile starts no new one.
      r.mingle.beginShutdown();
      expect(vi.getTimerCount()).toBe(0);
      r.channel.receive({ text: "or 9?", addressedToBot: false });
      expect(vi.getTimerCount()).toBe(0);
      expect(r.turns).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is set on groups only", async () => {
    const r = await setup();
    r.channel.receive({ text: "hello", chat: { platformId: "42", kind: "dm" } });
    await until(() => r.turns.length === 1);
    const dm = r.mingle.store.agentChats(r.agentId)[0]?.id as string;
    expect((await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${dm}/listen`, { listen: true })).status).toBe(
      404,
    );
    const group = await groupOf(r);
    expect(
      (await r.admin("PUT", `/v1/admin/agents/${r.agentId}/chats/${group}/listen`, { listen: "yes" })).status,
    ).toBe(400);
  });

  it("syncs the agent's reply to the first @-mention in a group even when the answer took several minutes", async () => {
    const base = Date.now();
    let clock = base;
    const realNow = Date.now;
    Date.now = () => clock;
    try {
      const r = await setup({ hearing: { quietMs: 60_000, maxWaitMs: 60_000, gapMs: 120_000 } });
      // First @-mention in a fresh group (no prior overheard messages yet).
      r.channel.receive({ text: "@alex can you check this?", sender: { id: "u1", name: "Alice", isBot: false } });
      await until(() => r.turns.length === 1 && r.channel.sent.length === 1);
      const groupId = r.mingle.store.agentChats(r.agentId)[0]?.id as string;
      // Simulate the agent's reply landing 5 minutes after the @-mention (past E decay threshold from the @-mention alone).
      const outMsg = r.mingle.store.chatMessages(groupId, 10).find((m) => m.direction === "out");
      expect(outMsg).toBeDefined();
      clock = base + 5 * 60_000;
      r.mingle.store.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(clock, outMsg?.id as string);
      // Alice writes a follow-up 2 seconds after the reply, without @-mentioning.
      clock += 2_000;
      r.channel.receive({
        text: "thanks, one more question",
        addressedToBot: false,
        sender: { id: "u1", name: "Alice", isBot: false },
      });
      // Because the reply at +5m was synced, Alice is still live and her follow-up reaches the agent on the fast lane.
      await until(() => r.turns.length === 2, 3_000);
      expect(r.turns[1]?.input).toContain("thanks, one more question");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("a thread that is one conversation", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const thread = { platformId: "-100:7", kind: "thread" as const, name: "Saturday", followUp: true as const };

  it("goes on without an @ once the agent has spoken there", async () => {
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
    });
    const r = current;
    // Before the agent said anything there, the thread is like the rest of the group.
    r.channel.receive({ text: "who is coming?", chat: thread, addressedToBot: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.turns).toHaveLength(0);
    r.channel.receive({ text: "@alex can you plan it?", chat: thread });
    await until(() => r.turns.length === 1 && r.channel.sent.length === 1);
    r.channel.receive({ text: "and the weather?", chat: thread, addressedToBot: false });
    // Reaches the agent: as a turn of its own, or steered into the one still finishing.
    const seen = () => r.turns.flatMap((t) => [t.input, ...t.steered]).join("\n");
    await until(() => seen().includes("and the weather?"));
    await new Promise((resolve) => setTimeout(resolve, 400));
    const turns = r.turns.length;
    // Another bot still needs an @, whatever the thread.
    r.channel.receive({
      text: "build passed",
      chat: thread,
      addressedToBot: false,
      sender: { id: "b9", name: "Bob", isBot: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.turns).toHaveLength(turns);
    expect(seen()).not.toContain("build passed");
  });

  it("does not follow up in a thread that is a lasting place", async () => {
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
    });
    const r = current;
    const topic = { platformId: "-100:9", kind: "thread" as const, name: "Gear" };
    r.channel.receive({ text: "@alex boots?", chat: topic });
    await until(() => r.turns.length === 1 && r.channel.sent.length === 1);
    r.channel.receive({ text: "I bought mine", chat: topic, addressedToBot: false });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(r.turns).toHaveLength(1);
  });
});
