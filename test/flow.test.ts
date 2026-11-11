import { afterEach, describe, expect, it } from "vitest";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/**
 * End to end: fake chat app → Mingle → OAR scripted harness → real `mingle` CLI
 * subprocess → local HTTP API → outbox → fake chat app.
 */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

describe("message flow", () => {
  it("answers through the CLI and marks the message replied", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input)) {
        const result = await runCli(t.options.env as Record<string, string>, ["message", "reply", id], `on it ${id}`);
        if (result.code !== 0) throw new Error(result.stderr);
      }
    });
    const { channel, mingle } = current;
    const inbound = channel.receive({ text: "what's the weather on Saturday?" });

    const sent = await until(() => channel.sent[0]);
    const stored = mingle.store.messageByPlatformId(
      mingle.store.agentChats(current.agentId)[0]?.id as string,
      inbound.platformId,
    );
    expect(sent.text).toBe(`on it ${stored?.id}`);
    expect(sent.replyTo).toBe(inbound.platformId);
    expect(channel.acks).toContain(inbound.platformId);
    await until(() => mingle.store.message(stored?.id as string)?.state === "replied");
    expect(current.turns[0]?.input).toMatch(
      /^\[msg=m\w+ chat=c\w+ im=telegram group="Weekend hikes" from="Zhang San" time=.+\]\nwhat's the weather on Saturday\?$/,
    );
  });

  it("turns a burst of messages into one turn", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    });
    current.channel.receive({ text: "first" });
    current.channel.receive({ text: "second", sender: { id: "u2", name: "Li Si", isBot: false } });
    await until(() => current?.channel.sent.length === 2);
    expect(current.turns).toHaveLength(1);
    expect(messageIds(current.turns[0]?.input ?? "")).toHaveLength(2);
  });

  it("steers messages that arrive mid-turn into the running turn", async () => {
    const firstStarted = Promise.withResolvers<void>();
    current = await rig(async (t) => {
      firstStarted.resolve();
      await t.tool("Bash", "sleep", () => sleep(600));
      const ids = [...messageIds(t.input), ...t.steered.flatMap(messageIds)];
      for (const id of ids)
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], `done ${id}`);
    });
    current.channel.receive({ text: "plan the route" });
    await firstStarted.promise;
    current.channel.receive({ text: "also check the weather", sender: { id: "u2", name: "Li Si", isBot: false } });
    await until(() => current?.channel.sent.length === 2);
    expect(current.turns).toHaveLength(1);
    expect(current.turns[0]?.steered).toHaveLength(1);
    expect(current.turns[0]?.steered[0]).toContain('from="Li Si"');
  });

  it("nudges once about unanswered messages, then marks them unanswered", async () => {
    current = await rig(async (t) => {
      // Ignore real messages; only answer when nudged.
      if (t.input.startsWith("[mingle] Not answered yet")) {
        const ids = (/Not answered yet: ([^.]+)\./.exec(t.input)?.[1] ?? "").split(", ");
        if (ids[0]) await runCli(t.options.env as Record<string, string>, ["message", "reply", ids[0]], "sorry, here");
      }
    });
    const { channel, mingle } = current;
    channel.receive({ text: "one" });
    await until(() => channel.sent.length === 1);
    expect(current.turns).toHaveLength(2);
    expect(current.turns[1]?.input).toMatch(/^\[mingle\] Not answered yet: m\w+\./);
    const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
    expect(mingle.store.chatMessages(chat, 10).find((m) => m.direction === "in")?.state).toBe("replied");
  });

  it("marks a message unanswered when the agent ignores the nudge too", async () => {
    current = await rig(async () => {});
    const { channel, mingle } = current;
    channel.receive({ text: "one" });
    await until(() => current?.turns.length === 2);
    const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
    await until(() => mingle.store.chatMessages(chat, 10)[0]?.state === "unanswered");
    await sleep(300);
    expect(current.turns).toHaveLength(2); // No third turn: one nudge only.
    expect(channel.sent).toHaveLength(0);
  });

  it("lets the owner stop the current turn with /stop", async () => {
    current = await rig(async (t) => {
      await t.tool("Bash", "long job", () => sleep(10_000, t.signal));
    });
    const { channel } = current;
    const dm = { platformId: "7", kind: "dm" as const, name: "Zhang San" };
    channel.receive({ text: "start the long job", chat: dm });
    await until(() => current?.turns.length === 1);
    await sleep(100);
    channel.receive({ text: "/stop", chat: dm });
    const reply = await until(() => channel.sent.find((m) => m.text === "Stopped."));
    expect(reply.chat.platformId).toBe("7");
  });

  it("ignores platform redeliveries and messages not addressed to the agent", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    });
    const { channel, mingle } = current;
    const first = channel.receive({ text: "hello" });
    channel.receive({ ...first, text: "hello" }); // Same platform ID: a redelivery.
    channel.receive({ text: "chatter between people", addressedToBot: false });
    await until(() => channel.sent.length === 1);
    await sleep(300);
    expect(channel.sent).toHaveLength(1);
    const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
    const inbound = mingle.store.chatMessages(chat, 10).filter((m) => m.direction === "in");
    expect(inbound.map((m) => m.state)).toEqual(["replied", "ignored"]);
  });
});

describe("agent CLI", () => {
  it("reads, searches, lists chats, tracks tasks and fires reminders", async () => {
    let env: Record<string, string> = {};
    const outputs: Record<string, string> = {};
    current = await rig(async (t) => {
      env = t.options.env as Record<string, string>;
      if (t.input.startsWith("[reminder=")) {
        outputs.reminder = t.input;
        return;
      }
      const [id] = messageIds(t.input);
      const chat = /chat=(c\w+)/.exec(t.input)?.[1] as string;
      outputs.chats = (await runCli(env, ["chat", "list"])).stdout;
      outputs.read = (await runCli(env, ["message", "read", chat])).stdout;
      outputs.search = (await runCli(env, ["message", "search", "ridge"])).stdout;
      outputs.task = (await runCli(env, ["task", "create", "Compare the routes", "--from", id as string])).stdout;
      outputs.reminderSet = (
        await runCli(env, ["reminder", "set", "Check the forecast", "--in", "1h", "--chat", chat])
      ).stdout;
      outputs.whoami = (await runCli(env, ["whoami"])).stdout;
      outputs.bad = (await runCli(env, ["message", "reply", "mnope1"], "x")).stderr;
      await runCli(env, ["message", "send", "--to", chat], "Saturday looks clear.");
    });
    const { channel, mingle } = current;
    channel.receive({ text: "is the ridge route open?" });
    await until(() => channel.sent.length === 1);

    expect(outputs.chats).toMatch(/^c\w+\s+telegram\s+group\s+Weekend hikes/);
    expect(outputs.read).toContain("is the ridge route open?");
    expect(outputs.search).toContain("is the ridge route open?");
    expect(outputs.task).toMatch(/^created t\w+: Compare the routes/);
    expect(outputs.reminderSet).toMatch(/^set r\w+, next at/);
    expect(outputs.whoami).toMatch(/^Alex \(scripted\)\nhome: .+\ntelegram: @alex_bot connected/);
    expect(outputs.bad).toBe(
      'error: message_not_found\nnext: no message mnope1. Use "mingle message read <chat>" or "mingle message search" to find message IDs\n',
    );
    expect(channel.sent[0]?.text).toBe("Saturday looks clear.");
    // A plain send to the chat counts as answering it.
    await until(() => mingle.store.awaitingReply(current?.agentId as string).length === 0);

    await until(() => !mingle.runtime(current?.agentId as string)?.busy);
    mingle.fireReminders(Date.now() + 2 * 3_600_000);
    await until(() => outputs.reminder);
    expect(outputs.reminder).toMatch(/^\[reminder=r\w+ chat=c\w+ time=.+\]\nCheck the forecast$/);
    expect(mingle.store.reminders(current.agentId)).toHaveLength(0);
  });

  it("refuses to run without an agent session", async () => {
    current = await rig(async () => {});
    const result = await runCli({ MINGLE_CLI: current.mingle.cliPath, MINGLE_API: "", MINGLE_TOKEN: "" }, [
      "chat",
      "list",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^error: not_in_agent_session/);
  });
});

describe("admin API (console)", () => {
  it("lists platforms, activity and work, and rejects bad tokens", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input)) {
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "Saturday is clear.");
        await runCli(t.options.env as Record<string, string>, ["task", "create", "Compare the routes", "--from", id]);
      }
    });
    const { channel, admin, agentId } = current;
    channel.receive({ text: "weather on Saturday?" });
    await until(() => channel.sent.length === 1);

    const platforms = (await admin("GET", "/v1/admin/platforms")).json as { platform: string; onboarding: unknown }[];
    expect(platforms.map((p) => p.platform)).toEqual([
      "wechat",
      "wecom",
      "feishu",
      "dingtalk",
      "qq",
      "slack",
      "discord",
      "telegram",
    ]);
    expect(platforms.find((p) => p.platform === "telegram")?.onboarding).not.toBeNull();
    expect(platforms.find((p) => p.platform === "feishu")?.onboarding).toBeNull();

    const activity = (await admin("GET", `/v1/admin/agents/${agentId}/activity`)).json as {
      direction: string;
      body: string;
      state: string;
    }[];
    expect(activity.map((m) => [m.direction, m.body, m.state])).toEqual([
      ["out", "Saturday is clear.", "sent"],
      ["in", "weather on Saturday?", "replied"],
    ]);

    await until(() => current?.mingle.store.tasks(agentId, false).length === 1);
    const work = (await admin("GET", `/v1/admin/agents/${agentId}/work`)).json as { tasks: { title: string }[] };
    expect(work.tasks.map((t) => t.title)).toEqual(["Compare the routes"]);

    const status = (await admin("GET", "/v1/admin/status")).json as { agents: { name: string; role: string }[] };
    expect(status.agents[0]).toMatchObject({ name: "Alex", role: expect.stringContaining("hikes") });

    expect((await admin("DELETE", "/v1/admin/connections/nnope")).status).toBe(404);
    const anonymous = await fetch(`${current.url}/v1/admin/status`);
    expect(anonymous.status).toBe(401);
  });
});
