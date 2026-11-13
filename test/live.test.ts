import { afterEach, describe, expect, it } from "vitest";
import { failureText, LiveReplies, stepKind } from "../src/core/live.ts";
import { type Failure, type Harness, HarnessError } from "../src/harness/harness.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("step labels", () => {
  it("names tools from different harnesses in plain words", () => {
    expect(stepKind("Bash")).toBe("command");
    expect(stepKind("exec_command")).toBe("command");
    expect(stepKind("Read")).toBe("read");
    expect(stepKind("apply_patch")).toBe("edit");
    expect(stepKind("Grep")).toBe("search");
    expect(stepKind("WebFetch")).toBe("web");
    expect(stepKind("TodoWrite")).toBe("plan");
    expect(stepKind("mystery")).toBe("other");
  });

  it("renders elapsed time and the latest steps, newest last", () => {
    let now = 0;
    const replies = new LiveReplies(
      () => {},
      () => now,
    );
    now = 75_000;
    const text = replies.render({
      lang: "zh",
      startedAt: 0,
      working: true,
      steps: [
        { kind: "read", count: 1 },
        { kind: "command", count: 3 },
        { kind: "web", count: 1 },
      ],
    });
    expect(text).toBe("**正在处理** · 1 分 15 秒\n\n- 查看文件\n- 运行命令 ×3\n- 查资料…");
  });
});

/** The harness reports every failed turn as `failure`, as a real one does for a sign-in or quota problem. */
const failingAs =
  (failure: Failure, reason: string) =>
  (harness: Harness): Harness => ({
    ...harness,
    name: () => "Claude Code",
    open: (options, events) =>
      harness.open(options, {
        ...events,
        onTurnEnded: (outcome) =>
          events.onTurnEnded(outcome.kind === "failed" ? { kind: "failed", reason, failure } : outcome),
      }),
  });

describe("failure notes", () => {
  it("says what went wrong and what helps, in the chat's language", () => {
    const why = { failure: "auth" as const, harness: "Claude Code" };
    expect(failureText("zh", why)).toBe(
      "Claude Code 没有登录，暂时回复不了。请在运行 Mingle 的电脑上登录 Claude Code，然后再发一次。",
    );
    expect(failureText("en", { ...why, failure: "overloaded" })).toMatch(/busy right now/);
    expect(failureText("en", { ...why, failure: "unknown" })).toBe("Something went wrong. Send it again in a moment.");
    expect(failureText("en", undefined)).toBe("Something went wrong. Send it again in a moment.");
  });

  it("gives the reset time of a usage limit when the harness reports it", () => {
    const now = new Date(2026, 10, 13, 9, 0).getTime();
    const resetsAt = new Date(2026, 10, 13, 14, 30).getTime();
    expect(failureText("zh", { failure: "quota", harness: "Codex", resetsAt }, now)).toBe(
      "Codex 的用量额度用完了，暂时回复不了，预计 14:30 恢复。",
    );
    // A reset time already past is not worth repeating.
    expect(failureText("en", { failure: "quota", harness: "Codex", resetsAt: now - 1 }, now)).toBe(
      "Codex has used up its usage limit, so I can't reply right now.",
    );
  });
});

describe("live replies", () => {
  it("shows progress at once, then turns into the answer", async () => {
    current = await rig(
      async (t) => {
        await t.tool("Bash", "curl forecast", () => sleep(1300));
        const [id] = messageIds(t.input);
        await runCli(t.options.env as Record<string, string>, ["message", "reply", id as string], "Saturday is clear.");
      },
      { live: true },
    );
    const { channel, mingle } = current;
    const inbound = channel.receive({ text: "weather on Saturday?" });

    const live = await until(() => channel.lives[0]);
    expect(live.replyTo).toBe(inbound.platformId);
    expect(live.updates[0]).toMatch(/^\*\*Thinking\*\* · 0s$/);
    await until(() => live.final);
    expect(live.final).toBe("Saturday is clear.");
    expect(live.updates.some((u) => u.includes("**Working**") && u.includes("Running a command"))).toBe(true);
    // The answer went into the live reply: no separate message.
    expect(channel.sent).toHaveLength(0);
    expect(channel.reactions).toEqual([`${inbound.platformId}:processing`, `${inbound.platformId}:done`]);
    const chat = mingle.store.agentChats(current.agentId)[0]?.id as string;
    const out = mingle.store.chatMessages(chat, 10).find((m) => m.direction === "out");
    expect(out).toMatchObject({ body: "Saturday is clear.", platformId: live.platformId, state: "sent" });
  });

  it("closes the live reply with a note when the message goes unanswered", async () => {
    current = await rig(async () => {}, { live: true });
    const { channel } = current;
    const inbound = channel.receive({ text: "hello?" });
    await until(() => channel.lives[0]?.final);
    expect(channel.lives[0]?.final).toBe("*This message did not get a reply.*");
    expect(channel.reactions.at(-1)).toBe(`${inbound.platformId}:none`);
  });

  it("marks the live reply answered when the agent sends to the chat instead of replying", async () => {
    current = await rig(
      async (t) => {
        const chat = /chat=(c\w+)/.exec(t.input)?.[1] as string;
        await runCli(t.options.env as Record<string, string>, ["message", "send", "--to", chat], "Here you go.");
      },
      { live: true },
    );
    const { channel } = current;
    channel.receive({ text: "anything new?" });
    await until(() => channel.lives[0]?.final);
    expect(channel.lives[0]?.final).toBe("*Answered below.*");
    expect(channel.sent.map((m) => m.text)).toEqual(["Here you go."]);
  });

  it("ends a failed turn with the reason in the live reply, without nudging the agent into it again", async () => {
    current = await rig(
      async () => {
        throw new Error("Not logged in · Please run /login");
      },
      { live: true, wrap: failingAs("auth", "Not logged in · Please run /login") },
    );
    const { channel, mingle, agentId, turns } = current;
    const inbound = channel.receive({ text: "hello?" });
    await until(() => channel.lives[0]?.final);
    expect(channel.lives[0]?.final).toBe(
      "*Claude Code is not signed in, so I can't reply. Sign in to Claude Code on the computer running Mingle, then send this again.*",
    );
    expect(channel.reactions.at(-1)).toBe(`${inbound.platformId}:error`);
    expect(channel.sent).toHaveLength(0);
    const chat = mingle.store.agentChats(agentId)[0]?.id as string;
    expect(mingle.store.chatMessages(chat, 10)[0]?.state).toBe("failed");
    expect(mingle.store.agent(agentId)).toMatchObject({ status: "error", statusFailure: "auth" });
    await sleep(500);
    expect(turns).toHaveLength(1);
  });

  it("sends the failure as a message where no live reply can carry it, once per burst", async () => {
    current = await rig(async () => {
      throw new Error("boom");
    });
    const { channel } = current;
    channel.receive({ text: "one" });
    await until(() => channel.sent[0]);
    expect(channel.sent[0]?.text).toBe("Something went wrong. Send it again in a moment.");
    channel.receive({ text: "two" });
    await sleep(800);
    expect(channel.sent).toHaveLength(1);
  });

  it("falls back to a plain message when the live reply cannot be finished", async () => {
    current = await rig(
      async () => {
        throw new Error("boom");
      },
      { live: true },
    );
    const { channel } = current;
    channel.finishFails = true;
    channel.receive({ text: "hello?" });
    await until(() => channel.sent[0]);
    expect(channel.sent[0]?.text).toBe("Something went wrong. Send it again in a moment.");
  });

  it("settles the reply when the session cannot even open", async () => {
    current = await rig(async () => {}, {
      live: true,
      wrap: (harness) => ({
        ...harness,
        name: () => "Codex",
        open: async () => {
          throw new HarnessError("not_installed", "codex is not installed on this computer");
        },
      }),
    });
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "hello?" });
    await until(() => channel.lives[0]?.final);
    expect(channel.lives[0]?.final).toBe("*Codex is not installed on this computer, so I can't reply.*");
    expect(mingle.store.agent(agentId)).toMatchObject({ status: "error", statusFailure: "not_installed" });
  });
});

describe("retrying messages", () => {
  /** A harness that fails while `broken`, then answers every message, saying what it was told. */
  const answering = (state: { broken: boolean }) => async (t: Parameters<Parameters<typeof rig>[0]>[0]) => {
    if (state.broken) throw new Error("Not logged in · Please run /login");
    for (const id of messageIds(t.input)) {
      await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "Sorry for the wait: yes.");
    }
  };

  it("answers a failed message once the owner retries it, telling the agent it is late", async () => {
    const state = { broken: true };
    current = await rig(answering(state), { live: true, wrap: failingAs("auth", "Not logged in · Please run /login") });
    const { channel, mingle, agentId, turns, admin } = current;
    const inbound = channel.receive({ text: "is Saturday on?" });
    const chat = await until(() => mingle.store.agentChats(agentId)[0]?.id);
    await until(() => mingle.store.chatMessages(chat, 10)[0]?.state === "failed");
    await until(() => channel.lives[0]?.final);

    state.broken = false;
    const { json } = await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, {});
    const id = mingle.store.chatMessages(chat, 10)[0]?.id as string;
    expect(json).toEqual({ retried: [id], offline: [] });

    // A new live reply opens on the same message and becomes the answer.
    await until(() => channel.lives[1]?.final);
    expect(channel.lives[1]).toMatchObject({ replyTo: inbound.platformId, final: "Sorry for the wait: yes." });
    expect(turns.at(-1)?.input).toMatch(new RegExp(`^\\[mingle\\] Retry: ${id} was not answered`));
    expect(turns.at(-1)?.input).toContain("is Saturday on?");
    expect(mingle.store.message(id)?.state).toBe("replied");
    expect(channel.reactions.slice(-2)).toEqual([`${inbound.platformId}:processing`, `${inbound.platformId}:done`]);
    // The error clears once the turn that answered it ends.
    await until(() => mingle.store.agent(agentId)?.status === "idle");
  });

  it("retries an unanswered message, and does nothing for messages that were answered", async () => {
    const state = { ignore: true };
    current = await rig(async (t) => {
      if (state.ignore) return;
      await answering({ broken: false })(t);
    });
    const { channel, mingle, agentId, turns, admin } = current;
    channel.receive({ text: "one" });
    const chat = await until(() => mingle.store.agentChats(agentId)[0]?.id);
    await until(() => mingle.store.chatMessages(chat, 10)[0]?.state === "unanswered");
    const id = mingle.store.chatMessages(chat, 10)[0]?.id as string;

    state.ignore = false;
    expect((await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [id] })).json).toEqual({
      retried: [id],
      offline: [],
    });
    await until(() => mingle.store.message(id)?.state === "replied");
    expect(channel.sent.map((m) => m.text)).toEqual(["Sorry for the wait: yes."]);

    // Already answered: a second click is a no-op, with no new turn.
    const before = turns.length;
    expect((await admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [id] })).json).toEqual({
      retried: [],
      offline: [],
    });
    await sleep(400);
    expect(turns).toHaveLength(before);
    expect((await admin("POST", "/v1/admin/agents/a_nope/messages/retry", {})).status).toBe(404);
  });
});
