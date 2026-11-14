import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_LIMIT, memoryHintDue } from "../src/core/home.ts";
import { Mingle } from "../src/core/mingle.ts";
import { holdUntil } from "../src/core/runtime.ts";
import type { Failure, Harness, HarnessEvents } from "../src/harness/harness.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** How the agent recovers: hints about its memory, waiting out a limit, resetting its session. */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** A turn that answers every chat message in its input, and records everything it was given. */
function answering(inputs: string[]) {
  return async (t: ScriptedTurn) => {
    inputs.push(t.input);
    for (const id of messageIds(t.input)) {
      await runCli(t.options.env as Record<string, string>, ["message", "reply", id], "ok");
    }
  };
}

describe("memory hint", () => {
  it("asks the agent to trim an oversized MEMORY.md once, after work that finished", async () => {
    const inputs: string[] = [];
    current = await rig(answering(inputs));
    const { mingle, channel, agentId } = current;
    const home = mingle.homeDir(mingle.agent(agentId));
    writeFileSync(join(home, "MEMORY.md"), "x".repeat(MEMORY_LIMIT + 4096));

    channel.receive({ text: "first" });
    await until(() => inputs.some((i) => i.startsWith("[mingle] Your MEMORY.md is 68 KB")));
    expect(inputs[0]).toContain("first");
    expect(mingle.store.memoryHint(agentId)?.size).toBe(MEMORY_LIMIT + 4096);

    // Within the day and not much larger: no second hint.
    await until(() => !mingle.runtime(agentId)?.busy);
    channel.receive({ text: "second" });
    await until(() => channel.sent.length + inputs.length >= 3 && inputs.some((i) => i.includes("second")));
    await until(() => !mingle.runtime(agentId)?.busy);
    await new Promise((r) => setTimeout(r, 300));
    expect(inputs.filter((i) => i.startsWith("[mingle] Your MEMORY.md"))).toHaveLength(1);

    // It grew by a quarter: told again.
    writeFileSync(join(home, "MEMORY.md"), "x".repeat(Math.ceil((MEMORY_LIMIT + 4096) * 1.3)));
    channel.receive({ text: "third" });
    await until(() => inputs.filter((i) => i.startsWith("[mingle] Your MEMORY.md")).length === 2);
  });

  it("stays quiet while MEMORY.md is within the limit", async () => {
    const inputs: string[] = [];
    current = await rig(answering(inputs));
    current.channel.receive({ text: "hello" });
    await until(() => inputs.length === 1 && !current?.mingle.runtime(current.agentId)?.busy);
    await new Promise((r) => setTimeout(r, 300));
    expect(inputs).toHaveLength(1);
    expect(current.mingle.store.memoryHint(current.agentId)).toBeUndefined();
  });
});

describe("reset session and diagnostics", () => {
  it("starts a new session and keeps the messages", async () => {
    const inputs: string[] = [];
    current = await rig(answering(inputs));
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "the secret word is pumpkin" });
    await until(() => channel.sent.length === 1 && !mingle.runtime(agentId)?.busy);
    const before = mingle.store.agent(agentId)?.sessionId;
    expect(before).toBeTruthy();

    const reset = await current.admin("POST", `/v1/admin/agents/${agentId}/reset`);
    expect(reset.status).toBe(200);
    // The new session opens after the call returns.
    const after = await until(() => {
      const id = mingle.store.agent(agentId)?.sessionId;
      return id && id !== before ? id : undefined;
    });

    // It still answers, in the new session, and the old message is still on record.
    channel.receive({ text: "still there?" });
    await until(() => channel.sent.length === 2);
    expect(mingle.store.agent(agentId)?.sessionId).toBe(after);
    expect(mingle.store.search(agentId, "pumpkin")).toHaveLength(1);
  });

  it("describes the agent without message text", async () => {
    const inputs: string[] = [];
    current = await rig(answering(inputs));
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "the secret word is pumpkin" });
    await until(() => channel.sent.length === 1 && !mingle.runtime(agentId)?.busy);
    const { status, json } = await current.admin("GET", `/v1/admin/agents/${agentId}/diagnostics`);
    expect(status).toBe(200);
    const text = (json as { text: string }).text;
    expect(text).toMatch(/^Mingle diagnostic info\n/);
    expect(text).toContain(`agent: ${agentId} · status idle`);
    expect(text).toContain(`session: ${mingle.store.agent(agentId)?.sessionId}`);
    expect(text).toMatch(/telegram \w+ · connected/);
    expect(text).toContain("replied 1");
    expect(text).not.toContain("pumpkin");
    expect(text).not.toContain("Alex");
  });
});

/** The next `fails` turns end as `failure`, the way a real harness reports a usage limit or a busy provider. */
function flaky(state: { fails: number }, failure: Failure, resetsAt?: () => number) {
  return (harness: Harness): Harness => ({
    ...harness,
    name: () => "Claude Code",
    open: (options, events) =>
      harness.open(options, {
        ...events,
        onTurnEnded: (outcome) => {
          if (state.fails <= 0) return events.onTurnEnded(outcome);
          state.fails--;
          const at = resetsAt?.();
          events.onTurnEnded({ kind: "failed", reason: failure, failure, ...(at ? { resetsAt: at } : {}) });
        },
      }),
  });
}

/** Answers like `answering`, except in a turn that is about to fail. */
function answeringUnless(state: { fails: number }, inputs: string[]) {
  const answer = answering(inputs);
  return async (t: ScriptedTurn) => {
    if (state.fails > 0) {
      inputs.push(t.input);
      return;
    }
    await answer(t);
  };
}

describe("waiting out a passing failure", () => {
  it("waits longer each time a provider stays busy, then gives up to the owner", () => {
    const now = 1_000_000;
    expect(holdUntil({ failure: "overloaded" }, 0, now)).toBe(now + 60_000);
    expect(holdUntil({ failure: "rate_limited" }, 1, now)).toBe(now + 5 * 60_000);
    expect(holdUntil({ failure: "provider" }, 2, now)).toBe(now + 15 * 60_000);
    expect(holdUntil({ failure: "overloaded" }, 3, now)).toBeUndefined();
    // What needs a person does not wait.
    expect(holdUntil({ failure: "auth" }, 0, now)).toBeUndefined();
    expect(holdUntil({ failure: "billing" }, 0, now)).toBeUndefined();
    // A usage limit waits until just past its reset, an hour at most at a time; without a reset time it fails.
    expect(holdUntil({ failure: "quota", resetsAt: now + 600_000 }, 0, now)).toBe(now + 615_000);
    expect(holdUntil({ failure: "quota", resetsAt: now + 5 * 3_600_000 }, 7, now)).toBe(now + 3_600_000);
    expect(holdUntil({ failure: "quota" }, 0, now)).toBeUndefined();
  });

  it("tells the person it will try again, and answers once the provider is back", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    current = await rig(answeringUnless(state, inputs), { live: true, wrap: flaky(state, "overloaded") });
    const { mingle, channel, agentId } = current;
    const inbound = channel.receive({ text: "weather on Saturday?" });
    const live = await until(() => (channel.lives[0]?.final ? channel.lives[0] : undefined));
    expect(live.final).toBe("*Claude Code is busy right now. I'll try again in 1 min; no need to send it again.*");
    const [waiting] = mingle.store.waiting(agentId);
    expect(waiting?.platformId).toBe(inbound.platformId);
    expect(waiting?.retryAt).toBeGreaterThan(Date.now() + 50_000);

    // Not yet due: nothing happens.
    mingle.resumeWaiting(Date.now());
    expect(mingle.store.waiting(agentId)).toHaveLength(1);
    // Due: delivered again, said to be late, and answered in a new live reply.
    mingle.resumeWaiting(Date.now() + 61_000);
    await until(() => channel.lives[1]?.final);
    expect(inputs[1]).toMatch(/^\[mingle\] Retry: m\w+ was not answered when it arrived/);
    expect(channel.lives[1]?.final).toBe("ok");
    expect(mingle.store.message(waiting?.id as string)?.state).toBe("replied");
  });

  it("holds every message until a usage limit resets, without delivering them meanwhile", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const resetsAt = Date.now() + 30 * 60_000;
    current = await rig(answeringUnless(state, inputs), { wrap: flaky(state, "quota", () => resetsAt) });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "first" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    // Told in a message of its own (no live reply here), with the reset time.
    await until(() => channel.sent.length === 1);
    expect(channel.sent[0]?.text).toMatch(
      /^Claude Code has used up its usage limit until \d\d:\d\d\. This message will wait and get a reply once it resets/,
    );
    expect(mingle.store.waiting(agentId)[0]?.retryAt).toBe(resetsAt + 15_000);

    // A message after it waits too, and the agent is not woken for it.
    channel.receive({ text: "second" });
    await until(() => mingle.store.waiting(agentId).length === 2);
    expect(inputs).toHaveLength(1);

    mingle.resumeWaiting(resetsAt + 16_000);
    await until(() => mingle.store.waiting(agentId).length === 0 && channel.sent.length >= 3);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContain("first");
    expect(inputs[1]).toContain("second");
  });

  it("lets the owner try at once or let it go, and drops waiting messages on pause", async () => {
    const state = { fails: 2 };
    const inputs: string[] = [];
    current = await rig(answeringUnless(state, inputs), { wrap: flaky(state, "rate_limited") });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "one" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const [first] = mingle.store.waiting(agentId);

    // Ignoring it ends the wait for good.
    const ignored = await current.admin("POST", `/v1/admin/agents/${agentId}/messages/ignore`, { ids: [first?.id] });
    expect(ignored.json).toEqual({ ignored: [first?.id] });
    mingle.resumeWaiting(Date.now() + 3_600_000);
    expect(mingle.store.message(first?.id as string)?.state).toBe("ignored");

    // Retrying tries now, without waiting for its time.
    channel.receive({ text: "two" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const [second] = mingle.store.waiting(agentId);
    await until(() => !mingle.runtime(agentId)?.busy);
    const retried = await current.admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, {});
    expect((retried.json as { retried: string[] }).retried).toEqual([second?.id]);
    await until(() => mingle.store.message(second?.id as string)?.state === "replied");

    // Pausing lets go of what was waiting, like what was in hand.
    state.fails = 1;
    channel.receive({ text: "three" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const [third] = mingle.store.waiting(agentId);
    await mingle.pauseAgent(agentId);
    expect(mingle.store.message(third?.id as string)?.state).toBe("ignored");
  });
});

describe("CR regression", () => {
  it("does not resume an old session when reset races with its opening", async () => {
    const gate = Promise.withResolvers<void>();
    const resumes: (string | null | undefined)[] = [];
    try {
      current = await rig(async () => {}, {
        wrap: (h) => ({
          ...h,
          open: async (options, events) => {
            resumes.push(options.resume);
            if (resumes.length === 1) await gate.promise;
            return h.open(options, events);
          },
        }),
      });
      const { mingle, agentId } = current;
      await until(() => resumes.length === 1);
      const result = await current.admin("POST", `/v1/admin/agents/${agentId}/reset`);
      expect(result.status).toBe(200);
      gate.resolve();
      await until(() => resumes.length >= 2 && Boolean(mingle.agent(agentId).sessionId));
      expect(resumes[1] ?? null).toBeNull();
    } finally {
      gate.resolve();
    }
  });

  it("revokes the old session token so its background work cannot send after reset", async () => {
    const envs: Record<string, string>[] = [];
    current = await rig(answering([]), {
      wrap: (h) => ({
        ...h,
        open: async (options, events) => {
          envs.push({ ...options.env });
          return h.open(options, events);
        },
      }),
    });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "before reset" });
    await until(() => channel.sent.length === 1 && !mingle.runtime(agentId)?.busy);
    const chat = mingle.store.agentChats(agentId)[0];
    const old = envs[0] as Record<string, string>;
    await current.admin("POST", `/v1/admin/agents/${agentId}/reset`);
    await until(() => envs.length >= 2 && Boolean(mingle.agent(agentId).sessionId));
    const result = await runCli(old, ["message", "send", "--to", chat?.id as string], "obsolete background result");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unauthorized");
    expect(channel.sent.some((m) => m.text === "obsolete background result")).toBe(false);
  });

  it("does not copy raw provider reasons into shareable diagnostics", async () => {
    current = await rig(async () => {}, {
      wrap: (h) => ({
        ...h,
        open: (options, events) =>
          h.open(options, {
            ...events,
            onTurnEnded: () =>
              events.onTurnEnded({
                kind: "failed",
                failure: "auth",
                reason: "Authorization: Bearer synthetic-private-key; request body: synthetic-private-chat",
              }),
          }),
      }),
    });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "trigger failed provider" });
    await until(() => mingle.agent(agentId).status === "error");
    const result = await current.admin("GET", `/v1/admin/agents/${agentId}/diagnostics`);
    expect(result.status).toBe(200);
    const text = (result.json as { text: string }).text;
    expect(text).not.toContain("synthetic-private-key");
    expect(text).not.toContain("synthetic-private-chat");
  });

  it("keeps the approved 64 KiB memory threshold", () => {
    expect(memoryHintDue(48 * 1024, undefined, Date.now())).toBe(false);
    expect(memoryHintDue(64 * 1024, undefined, Date.now())).toBe(false);
    expect(memoryHintDue(64 * 1024 + 1, undefined, Date.now())).toBe(true);
  });

  it("restores the quota block for new messages when Mingle restarts", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const reset = Date.now() + 30 * 60_000;
    current = await rig(
      async (t) => {
        inputs.push(t.input);
      },
      { wrap: flaky(state, "quota", () => reset) },
    );
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "first quota message" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const deadline = mingle.store.waiting(agentId)[0]?.retryAt;
    // Same pattern as the existing test/pause.test.ts restart persistence test.
    const again = new Mingle(mingle.options);
    try {
      await again.start("http://127.0.0.1:1");
      const incoming = channel.receive({ text: "new message before reset" });
      const chat = again.store.agentChats(agentId)[0] as { id: string };
      const message = await until(() => {
        const m = again.store.messageByPlatformId(chat.id, incoming.platformId);
        return m && m.state !== "received" ? m : undefined;
      });
      expect(message.state).toBe("waiting");
      expect(message.retryAt).toBe(deadline);
      expect(inputs).toHaveLength(1);
    } finally {
      await again.stop();
    }
  });

  it("ignores the retired session's events after reset", async () => {
    const opened: HarnessEvents[] = [];
    current = await rig(answering([]), {
      wrap: (h) => ({
        ...h,
        open: (options, events) => {
          opened.push(events);
          return h.open(options, events);
        },
      }),
    });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "before reset" });
    await until(() => channel.sent.length === 1 && !mingle.runtime(agentId)?.busy);
    const old = opened[0] as HarnessEvents;
    const result = await current.admin("POST", `/v1/admin/agents/${agentId}/reset`);
    expect(result.status).toBe(200);
    await until(() => opened.length >= 2 && Boolean(mingle.agent(agentId).sessionId));
    // Late events of the session that was retired must not touch the new one's work.
    old.onTurnStarted();
    old.onActivity("tool", "stale");
    old.onTurnEnded({ kind: "failed", failure: "auth", reason: "stale failure" });
    await new Promise((r) => setTimeout(r, 200));
    expect(mingle.agent(agentId).status).toBe("idle");
    expect(mingle.agent(agentId).statusDetail).toBeNull();
    expect(channel.sent).toHaveLength(1);
  });

  it("resets a paused agent without opening a session until resumed", async () => {
    const resumes: (string | null | undefined)[] = [];
    current = await rig(answering([]), {
      wrap: (h) => ({
        ...h,
        open: (options, events) => {
          resumes.push(options.resume);
          return h.open(options, events);
        },
      }),
    });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "before pause" });
    await until(() => channel.sent.length === 1 && !mingle.runtime(agentId)?.busy);
    await mingle.pauseAgent(agentId);
    const result = await current.admin("POST", `/v1/admin/agents/${agentId}/reset`);
    expect(result.status).toBe(200);
    expect(mingle.agent(agentId).sessionId).toBeNull();
    // Paused: no replacement session opens.
    await new Promise((r) => setTimeout(r, 200));
    expect(resumes).toHaveLength(1);
    expect(await mingle.resumeAgent(agentId)).toBe(true);
    await until(() => resumes.length === 2 && Boolean(mingle.agent(agentId).sessionId));
    expect(resumes[1] ?? null).toBeNull();
    channel.receive({ text: "after resume" });
    await until(() => channel.sent.length === 2);
  });

  it("carries queued notes into the replacement session", async () => {
    const gate = Promise.withResolvers<void>();
    const inputs: string[] = [];
    let first = true;
    try {
      current = await rig(async (t) => {
        inputs.push(t.input);
        if (first) {
          first = false;
          await gate.promise;
        }
      });
      const { mingle, channel, agentId } = current;
      channel.receive({ text: "start a long turn" });
      await until(() => inputs.length === 1);
      mingle.runtime(agentId)?.enqueueText("queued reminder fixture");
      const result = await current.admin("POST", `/v1/admin/agents/${agentId}/reset`);
      expect(result.status).toBe(200);
      gate.resolve();
      await until(() => inputs.length === 2);
      expect(inputs.filter((i) => i.includes("queued reminder fixture"))).toHaveLength(1);
    } finally {
      gate.resolve();
    }
  });

  it("keeps the persisted quota wait when the runtime closes", async () => {
    const state = { fails: 1 };
    const reset = Date.now() + 30 * 60_000;
    current = await rig(async () => {}, { wrap: flaky(state, "quota", () => reset) });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "limited" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const wait = mingle.store.quotaWait(agentId);
    expect(wait?.until).toBe(mingle.store.waiting(agentId)[0]?.retryAt);
    await mingle.runtime(agentId)?.dispose();
    expect(mingle.store.quotaWait(agentId)).toEqual(wait);
  });

  it("lets a newer quota wait hold back an earlier scheduled retry until the owner asks", async () => {
    const state = { fails: 2 };
    const inputs: string[] = [];
    const reset = Date.now() + 30 * 60_000;
    const classes: Failure[] = ["overloaded", "quota"];
    current = await rig(answeringUnless(state, inputs), {
      wrap: (h) => ({
        ...h,
        open: (options, events) =>
          h.open(options, {
            ...events,
            onTurnEnded: (outcome) => {
              if (state.fails <= 0) return events.onTurnEnded(outcome);
              const failure = classes[classes.length - state.fails] as Failure;
              state.fails--;
              events.onTurnEnded({
                kind: "failed",
                reason: failure,
                failure,
                ...(failure === "quota" ? { resetsAt: reset } : {}),
              });
            },
          }),
      }),
    });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "A hits a busy provider" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const a = mingle.store.waiting(agentId)[0] as { id: string; retryAt: number };
    channel.receive({ text: "B hits the usage limit" });
    await until(() => mingle.store.waiting(agentId).length === 2);
    const bDeadline = mingle.store.waiting(agentId)[1]?.retryAt as number;
    expect(bDeadline).toBe(reset + 15_000);

    // A's own retry time comes first: it waits again at the later quota time, no new input.
    mingle.resumeWaiting(a.retryAt);
    await until(() => {
      const m = mingle.store.message(a.id);
      return m?.state === "waiting" && m.retryAt === bDeadline;
    });
    expect(inputs).toHaveLength(2);

    // The owner asking to retry delivers it now.
    const retried = await current.admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [a.id] });
    expect((retried.json as { retried: string[] }).retried).toEqual([a.id]);
    await until(() => mingle.store.message(a.id)?.state === "replied");
  });

  it("does not copy connection error detail into diagnostics", async () => {
    current = await rig(answering([]));
    const { mingle, agentId } = current;
    const connection = mingle.store.connections(agentId)[0] as { id: string };
    mingle.store.updateConnection(connection.id, { state: "error", stateDetail: "synthetic-adapter-secret" });
    const result = await current.admin("GET", `/v1/admin/agents/${agentId}/diagnostics`);
    expect(result.status).toBe(200);
    const text = (result.json as { text: string }).text;
    expect(text).not.toContain("synthetic-adapter-secret");
  });
});
