import { scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Harness, HarnessSession } from "../src/harness/harness.ts";
import { oarHarness } from "../src/harness/harness.ts";
import { memorySecrets } from "../src/platform/secrets.ts";
import { type FakeChannel, messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

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
      /^\[msg=m\w+ chat=c\w+ im=telegram group="Weekend hikes" from="Zhang San" user=u\w+ time=.+\]\nwhat's the weather on Saturday\?$/,
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

  /**
   * Like Claude Code: the turn starts a background command and ends; when the command
   * finishes, the harness begins a turn of its own and the agent replies to the message.
   */
  function backgroundHarness(options: { stopTask: boolean; onCliResult?: (stderr: string) => void }) {
    const log = { stoppedTasks: 0, selfTurns: 0, aborts: 0 };
    const harness: Harness = {
      available: async () => [{ id: "scripted", name: "Scripted" }],
      open: async (opened, events) => {
        let turn: "prompted" | "self" | undefined;
        let task: NodeJS.Timeout | undefined;
        const env = opened.env as Record<string, string>;
        let closed = false;
        const endTurn = (kind: string) => {
          if (!turn || closed) return;
          turn = undefined;
          events.onTurnEnded({ kind });
        };
        return {
          id: "bg-session",
          resumed: false,
          deliver: async (text) => {
            const ids = messageIds(text);
            turn = "prompted";
            events.onTurnStarted();
            events.onActivity("tool", "Bash");
            if (ids.length > 0) {
              task = setTimeout(async () => {
                task = undefined;
                log.selfTurns++;
                turn = "self";
                events.onTurnStarted(true);
                events.onActivity("tool", "Bash");
                for (const id of ids) {
                  const result = await runCli(env, ["message", "reply", id], "TASK-DONE");
                  options.onCliResult?.(result.stderr);
                }
                endTurn("completed");
              }, 400);
            }
            // The turn itself waits for /stop, as the nudge turn did in MING-43.
            return { outcome: "prompted" };
          },
          abort: async () => {
            log.aborts++;
            const had = Boolean(turn) || Boolean(task);
            if (task && options.stopTask) {
              clearTimeout(task);
              task = undefined;
              log.stoppedTasks++;
            }
            setTimeout(() => endTurn("aborted"), 10);
            return had;
          },
          dispose: async () => {
            closed = true;
            clearTimeout(task);
          },
        };
      },
    };
    return { harness, log };
  }

  it("stops the background work a turn left running, so it does not answer after /stop", async () => {
    const { harness, log } = backgroundHarness({ stopTask: true });
    current = await rig(async () => {}, { harnessAdapter: harness });
    const { channel, mingle } = current;
    const dm = { platformId: "7", kind: "dm" as const, name: "Zhang San" };
    const job = channel.receive({ text: "run a 90 second job, then say TASK-DONE", chat: dm });
    await until(() => mingle.runtime(current?.agentId as string)?.busy);
    channel.receive({ text: "/stop", chat: dm });
    await until(() => channel.sent.find((m) => m.text === "Stopped."));
    await sleep(700);
    expect(log.stoppedTasks).toBe(1);
    expect(log.selfTurns).toBe(0);
    expect(channel.sent.map((m) => m.text)).toEqual(["Stopped."]);
    // Not nudged back into the work the owner stopped: one delivery, no "not answered yet" turn.
    const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
    await until(() => mingle.store.messageByPlatformId(chat, job.platformId)?.state === "unanswered");
  });

  it("aborts a turn the harness begins on its own after /stop and refuses its replies", async () => {
    const refusals: string[] = [];
    const { harness, log } = backgroundHarness({ stopTask: false, onCliResult: (e) => refusals.push(e) });
    current = await rig(async () => {}, { harnessAdapter: harness });
    const { channel, mingle } = current;
    const dm = { platformId: "7", kind: "dm" as const, name: "Zhang San" };
    channel.receive({ text: "run a 90 second job, then say TASK-DONE", chat: dm });
    await until(() => mingle.runtime(current?.agentId as string)?.busy);
    channel.receive({ text: "/stop", chat: dm });
    await until(() => channel.sent.find((m) => m.text === "Stopped."));
    await until(() => refusals.length === 1);
    expect(log.selfTurns).toBe(1);
    expect(log.aborts).toBe(2); // The stop, then the turn the finished command began.
    expect(refusals[0]).toContain("agent_stopped");
    expect(channel.sent.map((m) => m.text)).toEqual(["Stopped."]);
    await until(() => !mingle.runtime(current?.agentId as string)?.busy);

    // The next message is work again: it is answered as usual.
    channel.receive({ text: "now a new question", chat: dm });
    await until(() => channel.sent.some((m) => m.text === "TASK-DONE"));
    expect(mingle.runtime(current.agentId)?.halted).toBe(false);
  });

  it("answers from a background command that finishes on its own when nobody stopped it", async () => {
    const { harness, log } = backgroundHarness({ stopTask: true });
    current = await rig(async () => {}, { harnessAdapter: harness });
    current.channel.receive({ text: "run a job, then say TASK-DONE" });
    await until(() => current?.channel.sent.some((m) => m.text === "TASK-DONE"));
    expect(log.selfTurns).toBe(1);
    expect(log.aborts).toBe(0);
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

describe("group background", () => {
  it("tells the agent how much it missed, and reads it with --since", async () => {
    const inputs: string[] = [];
    let since = "";
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      inputs.push(t.input);
      const [id] = messageIds(t.input);
      if (inputs.length === 1) {
        await runCli(env, ["message", "reply", id as string], "ok");
        return;
      }
      const chat = /chat=(c\w+)/.exec(t.input)?.[1] as string;
      since = (await runCli(env, ["message", "read", chat, "--since", messageIds(inputs[0] as string)[0] as string]))
        .stdout;
      await runCli(env, ["message", "reply", id as string], "ok");
    });
    const { channel } = current;
    const base = Date.now();
    channel.receive({ text: "lunch at noon?", addressedToBot: false, sentAt: base - 30 });
    channel.receive({ text: "the ridge route is closed", addressedToBot: false, sentAt: base - 20 });
    channel.receive({ text: "what do you think?", sentAt: base - 10 });
    await until(() => channel.sent.length === 1);
    expect(inputs[0]).toMatch(/^\[msg=m\w+ chat=c\w+ .+ unseen=2\]\nwhat do you think\?$/);
    // The next question comes as a new turn, not into the one that is ending.
    await until(() => !current?.mingle.runtime(current.agentId)?.busy);

    const later = Date.now() + 10;
    channel.receive({ text: "the north trail then", addressedToBot: false, sentAt: later });
    channel.receive({ text: "agreed?", sentAt: later + 10 });
    await until(() => channel.sent.length === 2);
    expect(inputs[1]).toMatch(/ unseen=1\]\nagreed\?$/);
    // Everything after the first question, oldest first: the reply, the chatter, the new question.
    const bodies = since.split(/\n\n/).map((m) => m.split("\n")[1]);
    expect(bodies).toEqual(["ok", "the north trail then", "agreed?"]);
  });

  it("keeps a thread's channel as its background, without a turn for it", async () => {
    const inputs: string[] = [];
    current = await rig(async (t) => {
      inputs.push(t.input);
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    });
    const { channel, mingle } = current;
    const base = Date.now();
    // Shaped like Slack: chatter in the channel, then a mention that opens a thread under it.
    channel.receive({
      text: "lunch?",
      chat: { platformId: "C1", kind: "group" },
      addressedToBot: false,
      sentAt: base - 20,
    });
    channel.receive({
      text: "what do you think?",
      chat: { platformId: "C1:9", kind: "thread", parent: { platformId: "C1" } },
      sentAt: base - 10,
    });
    await until(() => channel.sent.length === 1);
    const chats = mingle.store.agentChats(current.agentId);
    const parent = chats.find((c) => c.platformId === "C1");
    const thread = chats.find((c) => c.platformId === "C1:9");
    expect(thread?.parentId).toBe(parent?.id);
    expect(mingle.store.chatMessages(parent?.id as string, 10).map((m) => m.state)).toEqual(["ignored"]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatch(new RegExp(` in=${parent?.id} .+ unseen=1\\]\nwhat do you think\\?$`));
  });

  it("refuses two read anchors at once", async () => {
    let stderr = "";
    let api: { status: number; error: string } | undefined;
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      const [id] = messageIds(t.input);
      const chat = /chat=(c\w+)/.exec(t.input)?.[1] as string;
      stderr = (await runCli(env, ["message", "read", chat, "--since", id as string, "--before", id as string])).stderr;
      // The API refuses the same combination for callers that skip the CLI.
      const res = await fetch(`${env.MINGLE_API}/v1/agent/chats/${chat}/messages?since=${id}&before=${id}`, {
        headers: { authorization: `Bearer ${env.MINGLE_TOKEN}` },
      });
      api = { status: res.status, error: ((await res.json()) as { error: string }).error };
      await runCli(env, ["message", "reply", id as string], "ok");
    });
    current.channel.receive({ text: "hi" });
    await until(() => current?.channel.sent.length === 1);
    expect(stderr).toBe("error: flags_conflict\nnext: pass only one of --before, --since and --around\n");
    expect(api).toEqual({ status: 400, error: "flags_conflict" });
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
      outputs.around = (await runCli(env, ["message", "read", chat, "--around", id as string])).stdout;
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
    // The last line of a search says how to read around a hit.
    expect(outputs.search).toMatch(/1 match, newest first\. .+ message read c\w+ --around m\w+$/m);
    expect(outputs.around).toContain("is the ridge route open?");
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
    expect((await admin("GET", `/v1/admin/agents/${agentId}`)).json).toMatchObject({ hasReplied: false });
    channel.receive({ text: "weather on Saturday?" });
    await until(() => channel.sent.length === 1);
    await until(() => current?.mingle.store.agent(agentId)?.hasReplied === true);
    expect((await admin("GET", `/v1/admin/agents/${agentId}`)).json).toMatchObject({ hasReplied: true });
    expect((await admin("GET", "/v1/admin/status")).json).toMatchObject({ agents: [{ hasReplied: true }] });

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

    const summary = (await admin("GET", "/v1/admin/summary")).json as {
      agents: { name: string; status: string; task: string | null; connections: { state: string }[] }[];
    };
    expect(summary.agents).toEqual([
      expect.objectContaining({
        name: "Alex",
        task: null, // created as todo, not yet in progress
        connections: [expect.objectContaining({ platform: "telegram", state: "connected" })],
        failed: 0,
        unanswered: 0,
      }),
    ]);
    const task = current.mingle.store.tasks(agentId, false)[0];
    current.mingle.store.setTaskStatus(agentId, task?.id as string, "in_progress");
    const working = (await admin("GET", "/v1/admin/summary")).json as typeof summary;
    expect(working.agents[0]?.task).toBe("Compare the routes");

    expect((await admin("DELETE", "/v1/admin/connections/nnope")).status).toBe(404);
    const anonymous = await fetch(`${current.url}/v1/admin/status`);
    expect(anonymous.status).toBe(401);
  });

  it("keeps onboarding complete outside the recent activity window", async () => {
    current = await rig(async () => {});
    const { mingle, agentId, admin } = current;
    const connection = mingle.store.connections(agentId)[0] as { id: string };
    const chat = mingle.store.upsertChat({ connectionId: connection.id, platformId: "history", kind: "dm" });
    const sent = mingle.store.insertOutbound({ chatId: chat.id, body: "First answer", replyTo: null });
    mingle.store.setOutboundResult(sent.id, "sent", "old-answer");
    for (let i = 0; i < 31; i++) {
      mingle.store.insertInbound({
        chatId: chat.id,
        platformId: `new-${i}`,
        senderId: "u1",
        senderName: "Owner",
        body: "Later message",
        attachments: [],
        replyTo: null,
        triggers: true,
        createdAt: Date.now() + i + 1,
      });
    }
    const activity = (await admin("GET", `/v1/admin/agents/${agentId}/activity?limit=30`)).json as {
      direction: string;
    }[];
    expect(activity).toHaveLength(30);
    expect(activity.every((m) => m.direction === "in")).toBe(true);
    expect((await admin("GET", `/v1/admin/agents/${agentId}`)).json).toMatchObject({ hasReplied: true });
    await mingle.removeConnection(connection.id);
    expect((await admin("GET", `/v1/admin/agents/${agentId}`)).json).toMatchObject({
      hasReplied: true,
      connections: [],
    });
  });
});

describe("agent settings", () => {
  it("renames the agent and changes its model; a new model keeps the session", async () => {
    current = await rig(async () => {});
    const { mingle, agentId } = current;
    // Startup opens a session now; wait for its id before simulating an older one.
    await until(() => mingle.store.agent(agentId)?.sessionId);
    mingle.store.setSessionId(agentId, "s-1");
    const renamed = await current.admin("PATCH", `/v1/admin/agents/${agentId}`, { name: " Alex 2 ", model: "sonnet" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ name: "Alex 2", model: "sonnet" });
    expect(mingle.store.agent(agentId)?.sessionId).toBe("s-1");
    // Back to the harness's default.
    await current.admin("PATCH", `/v1/admin/agents/${agentId}`, { model: "" });
    expect(mingle.store.agent(agentId)?.model).toBeNull();
    const empty = await current.admin("PATCH", `/v1/admin/agents/${agentId}`, { name: "  " });
    expect(empty.json).toMatchObject({ error: "name_required" });
  });

  it("refuses a harness that is not installed", async () => {
    current = await rig(async () => {});
    const refused = await current.admin("PATCH", `/v1/admin/agents/${current.agentId}`, { harness: "nope" });
    expect(refused.json).toMatchObject({ error: "harness_unavailable" });
  });

  /** A real adapter over the scripted runtime, with extra/blocked list entries. */
  const wrappedHarness = (disabled: Record<string, { code: string; reason: string }>): Harness => {
    const inner = oarHarness({ require: () => scriptedRuntime({ id: "scripted", turn: async () => {} }) });
    return {
      ...inner,
      available: async () => [
        ...[...(await inner.available()), { id: "scripted", name: "Scripted" }, { id: "other-ok", name: "Other" }].map(
          (h) => {
            const d = disabled[h.id];
            return d ? { ...h, disabled: d } : h;
          },
        ),
        // Extra entries that exist only as disabled choices.
        ...Object.entries(disabled)
          .filter(([id]) => id !== "scripted" && id !== "other-ok")
          .map(([id, d]) => ({ id, name: id, disabled: d })),
      ],
    };
  };

  const blocked = {
    harness_opencode_version: {
      code: "harness_opencode_version",
      reason: "This OpenCode version is not compatible with Mingle. Use OpenCode 1.x or choose another harness.",
    },
  };

  it("rejects creating an agent on a disabled harness", async () => {
    current = await rig(async () => {}, { harnessAdapter: wrappedHarness(blocked) });
    const before = current.mingle.store.agents().length;
    const created = await current.admin("POST", "/v1/admin/agents", {
      name: "Bob",
      harness: "harness_opencode_version",
    });
    expect(created.status).toBe(400);
    expect(created.json).toMatchObject({ error: "harness_opencode_version" });
    expect(current.mingle.store.agents()).toHaveLength(before);
  });

  it("answers the harness list from a cache warmed at start", async () => {
    let probes = 0;
    current = await rig(async () => {}, {
      wrap: (h) => ({
        ...h,
        available: async () => {
          probes++;
          return h.available();
        },
      }),
    });
    const { mingle, agentId } = current;
    await until(() => probes === 1);
    for (let i = 0; i < 3; i++) expect((await current.admin("GET", "/v1/admin/harnesses")).status).toBe(200);
    // A settings change validates the harness against the cache too.
    expect((await current.admin("PATCH", `/v1/admin/agents/${agentId}`, { model: "m2" })).status).toBe(200);
    expect(probes).toBe(1);
    expect(mingle.store.agent(agentId)?.model).toBe("m2");
  });

  it("looks again before refusing a harness installed after the last look", async () => {
    let installed = false;
    current = await rig(async () => {}, {
      wrap: (h) => ({
        ...h,
        available: async () => [...(await h.available()), ...(installed ? [{ id: "late", name: "Late" }] : [])],
      }),
    });
    const { mingle, agentId } = current;
    expect((await current.admin("GET", "/v1/admin/harnesses")).json).not.toContainEqual(
      expect.objectContaining({ id: "late" }),
    );
    installed = true;
    const switched = await current.admin("PATCH", `/v1/admin/agents/${agentId}`, { harness: "late" });
    expect(switched.status).toBe(200);
    expect(mingle.store.agent(agentId)?.harness).toBe("late");
  });

  it("rejects switching to a disabled harness and keeps every setting", async () => {
    current = await rig(async () => {}, { harnessAdapter: wrappedHarness(blocked) });
    const { mingle, agentId } = current;
    const before = mingle.store.agent(agentId);
    const refused = await current.admin("PATCH", `/v1/admin/agents/${agentId}`, {
      harness: "harness_opencode_version",
    });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: "harness_opencode_version" });
    const after = mingle.store.agent(agentId);
    expect(after?.harness).toBe(before?.harness);
    expect(after?.model).toBe(before?.model);
    expect(after?.sessionId).toBe(before?.sessionId);
    expect(mingle.store.connections(agentId)).toHaveLength(1);
  });

  it("rejects a model-only change while the current harness is disabled", async () => {
    current = await rig(async () => {}, {
      harnessAdapter: wrappedHarness({ scripted: blocked.harness_opencode_version }),
    });
    const { mingle, agentId } = current;
    const refused = await current.admin("PATCH", `/v1/admin/agents/${agentId}`, { model: "sonnet" });
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ error: "harness_opencode_version" });
    expect(mingle.store.agent(agentId)?.model).toBeNull();
  });

  it("still allows name and role edits and deleting a blocked agent", async () => {
    current = await rig(async () => {}, {
      harnessAdapter: wrappedHarness({ scripted: blocked.harness_opencode_version }),
    });
    const { admin, agentId, mingle } = current;
    const renamed = await admin("PATCH", `/v1/admin/agents/${agentId}`, { name: "Alex 2" });
    expect(renamed.status).toBe(200);
    expect(renamed.json).toMatchObject({ name: "Alex 2" });
    expect((await admin("PUT", `/v1/admin/agents/${agentId}/role`, { role: "fixture role" })).status).toBe(200);
    expect((await admin("DELETE", `/v1/admin/agents/${agentId}`)).status).toBe(200);
    expect(mingle.store.agent(agentId)).toBeUndefined();
  });

  it("switches to a compatible harness when one is offered", async () => {
    current = await rig(async () => {}, { harnessAdapter: wrappedHarness(blocked) });
    const { mingle, agentId } = current;
    const switched = await current.admin("PATCH", `/v1/admin/agents/${agentId}`, { harness: "other-ok" });
    expect(switched.status).toBe(200);
    expect(mingle.store.agent(agentId)?.harness).toBe("other-ok");
    await until(() => mingle.store.agent(agentId)?.sessionId);
  });
});

describe("eager session startup", () => {
  const stubSession = (id: string, dispose: () => void = () => {}): HarnessSession => ({
    id,
    resumed: false,
    deliver: async () => ({ outcome: "prompted" }),
    abort: async () => false,
    dispose: async () => dispose(),
  });

  const stubHarness = (open: Harness["open"]): Harness => ({
    available: async () => [{ id: "scripted", name: "Scripted" }],
    open,
  });

  it("opens the session at start, before any message, and reuses it for the first input", async () => {
    const deliveries: string[] = [];
    const open = vi.fn(async () => ({
      ...stubSession("s-start"),
      deliver: async (text: string) => {
        deliveries.push(text);
        return { outcome: "prompted" as const };
      },
    }));
    current = await rig(async () => {}, { harnessAdapter: stubHarness(open) });
    await until(() => open.mock.calls.length === 1);
    expect(current.turns).toHaveLength(0);
    expect(current.channel.sent).toHaveLength(0);

    current.channel.receive({ text: "hello" });
    await until(() => deliveries.length === 1);
    expect(open).toHaveBeenCalledOnce(); // The startup session was reused, not reopened.
    expect(deliveries[0]).toContain("hello");
  });

  it("surfaces an undeclared startup failure before the first message", async () => {
    let fail = true;
    const open = vi.fn(async () => {
      if (fail) throw new Error("fixture startup failure");
      return stubSession("s-recovered");
    });
    current = await rig(async () => {}, { harnessAdapter: stubHarness(open) });
    await until(() => current?.mingle.store.agent(current.agentId)?.status === "error");
    expect(current.mingle.store.agent(current.agentId)?.statusDetail).toContain("fixture startup failure");
    expect(current.channel.sent).toHaveLength(0);

    // A brain-side change reopens and clears the error on success.
    fail = false;
    const renamed = await current.admin("PATCH", `/v1/admin/agents/${current.agentId}`, { name: "Alex 2" });
    expect(renamed.status).toBe(200);
    await until(() => current?.mingle.store.agent(current.agentId)?.status === "idle");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("preserves input after failed startup and retries it once the brain recovers", async () => {
    let failing = true;
    const deliveries: string[] = [];
    const open = vi.fn(async () => {
      if (failing) throw new Error("fixture startup failure");
      return {
        ...stubSession("s-recovered"),
        deliver: async (text: string) => {
          deliveries.push(text);
          return { outcome: "prompted" as const };
        },
      };
    });
    current = await rig(async () => {}, { harnessAdapter: stubHarness(open) });
    const { mingle, agentId, channel, admin } = current;
    await until(() => mingle.store.agent(agentId)?.status === "error");

    const inbound = channel.receive({ text: "retained input" });
    const chat = await until(() => mingle.store.agentChats(agentId)[0]?.id);
    await until(() => mingle.store.messageByPlatformId(chat, inbound.platformId)?.state === "failed");
    const stored = mingle.store.messageByPlatformId(chat, inbound.platformId);
    expect(stored?.body).toBe("retained input");
    expect(deliveries).toHaveLength(0);

    failing = false;
    const patched = await admin("PATCH", `/v1/admin/agents/${agentId}`, { model: "fixture-model" });
    expect(patched.status).toBe(200);
    await until(() => mingle.store.agent(agentId)?.status === "idle");
    expect(deliveries).toHaveLength(0);
    const retried = await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [stored?.id] });
    expect(retried.status).toBe(200);
    expect(retried.json).toEqual({ retried: [stored?.id], offline: [] });
    await until(() => deliveries.length === 1);
    expect(deliveries[0]).toContain("retained input");
    expect(deliveries[0]).toContain("[mingle] Retry:");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("dispose waits for a pending open and tears down the arrived session once", async () => {
    const gate = Promise.withResolvers<HarnessSession>();
    let disposed = 0;
    const open = vi.fn(() => gate.promise);
    current = await rig(async () => {}, { harnessAdapter: stubHarness(open) });
    const { mingle, agentId } = current;
    await until(() => open.mock.calls.length === 1);
    const stopped = mingle.runtime(agentId)?.dispose() as Promise<void>;
    gate.resolve(stubSession("s-late", () => disposed++));
    await stopped;
    expect(disposed).toBe(1); // The late session was dropped inside open(), not kept.
    expect(mingle.store.agent(agentId)?.sessionId).toBeNull();
    expect(mingle.store.agent(agentId)?.status).toBe("offline");
  });
});

describe("waking from sleep", () => {
  it("reconnects every chat app and keeps answering", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input))
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "back");
    });
    const { channel, mingle } = current;
    expect(channel.connects).toBe(1);

    await mingle.resume("test");
    expect(channel.closes).toBe(1);
    expect(channel.connects).toBe(2);
    expect(mingle.store.connections()[0]?.state).toBe("connected");

    channel.receive({ text: "still there?" });
    await until(() => channel.sent.length === 1);
  });

  it("keeps trying when the network is not back yet", async () => {
    current = await rig(async () => {});
    const { channel, mingle } = current;
    const id = mingle.store.connections()[0]?.id as string;
    channel.connectFailures = 2;
    await mingle.resume("test");
    // Offline, but with a time for the next try: never offline with nothing to do.
    expect(mingle.store.connection(id)).toMatchObject({ state: "error", stateDetail: "network" });
    expect(mingle.retryAt(id)).toBeGreaterThan(0);
    expect(mingle.isLive(id)).toBe(false);
    await until(() => mingle.store.connection(id)?.state === "connected");
    expect(mingle.isLive(id)).toBe(true);
    expect(mingle.retryAt(id)).toBeNull();
    expect(channel.connects).toBe(4);
  });

  it("starts over when the adapter gives up, and waits for the owner on refused credentials", async () => {
    current = await rig(async () => {});
    const { channel, mingle, admin } = current;
    const id = mingle.store.connections()[0]?.id as string;
    channel.report({ kind: "error", code: "unknown" });
    expect(mingle.isLive(id)).toBe(false);
    await until(() => mingle.store.connection(id)?.state === "connected");
    expect(channel.connects).toBe(2);

    channel.report({ kind: "error", code: "credentials_revoked" });
    expect(mingle.store.connection(id)).toMatchObject({ state: "error", stateDetail: "credentials_revoked" });
    expect(mingle.retryAt(id)).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(channel.connects).toBe(2);

    // The owner presses "Reconnect".
    const reconnected = await admin("POST", `/v1/admin/connections/${id}/reconnect`);
    expect(reconnected.json).toEqual({ state: "connected", detail: null });
    expect(channel.connects).toBe(3);
    const view = (await admin("GET", `/v1/admin/agents/${current.agentId}`)).json as {
      connections: { retryAt: number | null }[];
    };
    expect(view.connections[0]?.retryAt).toBeNull();
  });

  it("names the offline bot when a retry cannot run", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId, admin } = current;
    const id = mingle.store.connections()[0]?.id as string;
    const inbound = channel.receive({ text: "anyone?" });
    const chat = await until(() => mingle.store.agentChats(agentId)[0]?.id);
    await until(() => mingle.store.messageByPlatformId(chat, inbound.platformId)?.state === "unanswered");
    const message = mingle.store.messageByPlatformId(chat, inbound.platformId)?.id as string;
    channel.connectFailures = 100;
    channel.report({ kind: "error", code: "network" });
    const retried = await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [message] });
    expect(retried.json).toEqual({ retried: [], offline: [id] });
  });

  it("ignores reports from a connection already replaced", async () => {
    current = await rig(async () => {});
    const { channel, mingle } = current;
    const id = mingle.store.connections()[0]?.id as string;
    const old = (channel as unknown as { events: Parameters<FakeChannel["connect"]>[1] }).events;
    await mingle.reconnect(id);
    old.onState({ kind: "error", code: "credentials_revoked" });
    expect(mingle.store.connection(id)?.state).toBe("connected");
  });

  it("leaves a connection removed meanwhile alone", async () => {
    current = await rig(async () => {});
    const { channel, mingle } = current;
    const id = mingle.store.connections()[0]?.id as string;
    const resumed = mingle.resume("test");
    await mingle.removeConnection(id);
    await resumed;
    expect(mingle.store.connections()).toEqual([]);
    expect(mingle.isLive(id)).toBe(false);
    expect(channel.closes).toBe(channel.connects);
  });
});

describe("binding a bot again", () => {
  it("keeps the first connection working with the new credentials when another agent scans the same bot", async () => {
    const secrets = memorySecrets();
    current = await rig(async () => {}, { secrets });
    const { channel, mingle } = current;
    const first = mingle.store.connections()[0] as { id: string; secretRef: string };
    const other = mingle.createAgent({ name: "Bea", role: "", harness: "scripted", model: null });
    // Scanning again issued a new secret, which revokes the one the first connection had.
    channel.onboardCredentials = { token: "rotated" };

    await expect(mingle.addConnection(other.id, "telegram", { token: "rotated" })).rejects.toMatchObject({
      code: "bot_in_use",
    });
    expect(mingle.store.connections().map((c) => c.id)).toEqual([first.id]);
    expect(JSON.parse((await secrets.get(first.secretRef)) as string)).toEqual({ token: "rotated" });
    expect(channel.lastCredentials).toEqual({ token: "rotated" });
    expect(mingle.store.connection(first.id)?.state).toBe("connected");
  });

  it("rebinds the same agent's bot instead of refusing it", async () => {
    const secrets = memorySecrets();
    current = await rig(async () => {}, { secrets });
    const { channel, mingle, agentId } = current;
    const first = mingle.store.connections()[0] as { id: string; secretRef: string };
    channel.onboardCredentials = { token: "rotated" };

    const again = await mingle.addConnection(agentId, "telegram", { token: "rotated" });
    expect(again.id).toBe(first.id);
    expect(mingle.store.connections()).toHaveLength(1);
    expect(JSON.parse((await secrets.get(first.secretRef)) as string)).toEqual({ token: "rotated" });
    expect(mingle.store.connection(first.id)?.state).toBe("connected");
  });
});

describe("contacts", () => {
  it("tells two owners on one platform apart, and lets the agent and the console name them", async () => {
    const seen: string[] = [];
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      seen.push(t.input);
      const user = /user=(u\w+)/.exec(t.input)?.[1] as string;
      if (!t.input.includes("from=")) {
        const named = await runCli(env, ["contact", "name", user, "Mei"]);
        if (named.code !== 0) throw new Error(named.stderr);
      }
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], "ok");
    });
    const { mingle, agentId, admin, channel } = current;
    const mine = mingle.store.connections(agentId)[0] as { id: string };
    mingle.store.updateConnection(mine.id, { ownerId: "me" });
    // A second bot on the same platform, scanned by someone else: it has its own owner.
    const hers = mingle.store.createConnection({ agentId, platform: "telegram", secretRef: "telegram:bot2" });
    mingle.store.updateConnection(hers.id, { ownerId: "her", botId: "bot2", botName: "@alex_bot" });

    const dm = { platformId: "me", kind: "dm" as const };
    channel.receive({ text: "hello from me", chat: dm, sender: { id: "me", name: "", isBot: false } });
    await until(() => channel.sent.length === 1);
    expect(seen[0]).toMatch(/ dm user=u\w+ owner time=/);
    expect(seen[0]).not.toContain("from=");

    const activity = async () =>
      (await admin("GET", `/v1/admin/agents/${agentId}/activity`)).json as {
        body: string;
        sender: string | null;
        senderIsOwner: boolean;
        senderIsOnlyOwner: boolean;
        contactId: string | null;
      }[];
    const fromMe = (await activity()).find((m) => m.body === "hello from me");
    // Two owners on one platform: neither may be shown as "you".
    expect(fromMe).toMatchObject({ senderIsOwner: true, senderIsOnlyOwner: false, contactId: expect.any(String) });

    // The agent named the unnamed sender, so its next message carries the name.
    expect(mingle.store.contact(fromMe?.contactId as string)?.alias).toBe("Mei");
    channel.receive({ text: "me again", chat: dm, sender: { id: "me", name: "", isBot: false } });
    // It may arrive as a new turn or be steered into the one still finishing.
    const again = await until(() =>
      current?.turns.flatMap((t) => [t.input, ...t.steered]).find((input) => input.includes("me again")),
    );
    expect(again).toMatch(/ dm from="Mei" user=u\w+ owner time=/);
    expect((await activity()).find((m) => m.body === "me again")?.sender).toBe("Mei");

    // The console renames it, and sees the owner on the connection.
    const renamed = await admin("PATCH", `/v1/admin/agents/${agentId}/contacts/${fromMe?.contactId}`, {
      name: "  Wei  ",
    });
    expect(renamed.json).toEqual({ id: fromMe?.contactId, name: "Wei" });
    const status = (await admin("GET", `/v1/admin/agents/${agentId}`)).json as {
      connections: { id: string; ownerShared: boolean; ownerContact: { name: string | null } | null }[];
    };
    expect(status.connections.find((c) => c.id === mine.id)).toMatchObject({
      ownerShared: true,
      ownerContact: { name: "Wei" },
    });
    expect(
      (await admin("PATCH", `/v1/admin/agents/${agentId}/contacts/${fromMe?.contactId}`, { name: "x".repeat(65) }))
        .status,
    ).toBe(400);
    expect((await admin("PATCH", `/v1/admin/agents/${agentId}/contacts/unope`, { name: "x" })).status).toBe(404);

    // One owner per platform again: an unnamed owner can be "you".
    await mingle.removeConnection(hers.id);
    await admin("PATCH", `/v1/admin/agents/${agentId}/contacts/${fromMe?.contactId}`, { name: "" });
    // A second bot owned by the same account does not make two people either.
    const another = mingle.store.createConnection({ agentId, platform: "telegram", secretRef: "telegram:bot3" });
    mingle.store.updateConnection(another.id, { ownerId: "me", botId: "bot3" });
    const alone = (await activity()).find((m) => m.body === "hello from me");
    expect(alone).toMatchObject({ sender: null, senderIsOnlyOwner: true });
  });
});
