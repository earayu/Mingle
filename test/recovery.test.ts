import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_LIMIT, memoryHintDue } from "../src/core/home.ts";
import { Mingle } from "../src/core/mingle.ts";
import { holdUntil } from "../src/core/runtime.ts";
import { type Failure, type Harness, HarnessError, type HarnessEvents } from "../src/harness/harness.ts";
import { memorySecrets, type SecretStore } from "../src/platform/secrets.ts";
import { Store } from "../src/store/store.ts";
import { FakeChannel, messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** How the agent recovers: hints about its memory, waiting out a limit, resetting its session. */

let current: Rig | undefined;
const releaseGates: (() => void)[] = [];
afterEach(async () => {
  for (const release of releaseGates.splice(0)) release();
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

    // Trimmed under the limit: forgotten, so growing past it again within the day is told at once.
    await until(() => !mingle.runtime(agentId)?.busy);
    writeFileSync(join(home, "MEMORY.md"), "short\n");
    channel.receive({ text: "fourth" });
    await until(() => mingle.store.memoryHint(agentId) === undefined);
    await until(() => !mingle.runtime(agentId)?.busy);
    writeFileSync(join(home, "MEMORY.md"), "x".repeat(MEMORY_LIMIT + 1024));
    channel.receive({ text: "fifth" });
    await until(() => inputs.filter((i) => i.startsWith("[mingle] Your MEMORY.md")).length === 3);
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
    expect(text).toContain("sign-in: this computer's\n");
    expect(text).toMatch(/last message in: \d{4}-\d\d-\d\dT[\d:.]+Z · last reply out: \d{4}-/);
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
    // Without a reset time it still waits, longer each time, for about a day.
    expect(holdUntil({ failure: "quota" }, 0, now)).toBe(now + 5 * 60_000);
    expect(holdUntil({ failure: "quota", resetsAt: now - 1 }, 2, now)).toBe(now + 30 * 60_000);
    expect(holdUntil({ failure: "quota" }, 10, now)).toBe(now + 3_600_000);
    expect(holdUntil({ failure: "quota" }, 24, now)).toBeUndefined();
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

describe("a usage limit shared by a sign-in", () => {
  it("holds the other agents on the same sign-in, and ends when a later turn there completes", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const resetsAt = Date.now() + 30 * 60_000;
    current = await rig(answeringUnless(state, inputs), { wrap: flaky(state, "quota", () => resetsAt) });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Bea", role: "", harness: "scripted", model: null });
    const own = mingle.createAgent({ name: "Cy", role: "", harness: "scripted", model: null });
    // Cy signs in with a key of its own: not the computer's sign-in, so not its limit.
    await mingle.setEnv(own.id, "ANTHROPIC_API_KEY", "sk-test");

    channel.receive({ text: "first" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    expect(mingle.runtime(peer.id)?.limit?.until).toBe(resetsAt + 15_000);
    expect(mingle.store.quotaWait(peer.id)).toEqual({ until: resetsAt + 15_000, resetsAt });
    expect(mingle.runtime(own.id)?.limit).toBeUndefined();
    // An agent added while the limit lasts waits too, and the wait is persisted for it at once,
    // so a restart restores it even after the reporting agent moves to a scope of its own.
    const late = mingle.createAgent({ name: "Dee", role: "", harness: "scripted", model: null });
    expect(mingle.runtime(late.id)?.limit?.until).toBe(resetsAt + 15_000);
    expect(mingle.store.quotaWait(late.id)).toEqual({ until: resetsAt + 15_000, resetsAt });

    // The owner tries Alex again and it works: the account answers, so every wait on it ends.
    await until(() => !mingle.runtime(agentId)?.busy);
    await current.admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, {});
    await until(() => mingle.store.waiting(agentId).length === 0 && channel.sent.length >= 2);
    await until(() => mingle.runtime(peer.id)?.limit === undefined);
    expect(mingle.store.quotaWait(peer.id)).toBeUndefined();
    expect(mingle.runtime(late.id)?.limit).toBeUndefined();
  });
});

describe("PR65 review regressions", () => {
  it("forgets a released shared wait before a paused peer resumes", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    current = await rig(answeringUnless(state, inputs), {
      wrap: flaky(state, "quota", () => Date.now() + 1_800_000),
    });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Paused peer", role: "", harness: "scripted" });
    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    await mingle.pauseAgent(peer.id);
    await until(() => !mingle.runtime(agentId)?.busy);
    await current.admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, {});
    await until(
      () => mingle.store.waiting(agentId).length === 0 && channel.sent.length >= 2 && !mingle.runtime(agentId)?.busy,
    );
    await mingle.resumeAgent(peer.id);
    expect(mingle.runtime(peer.id)?.limit).toBeUndefined();
    expect(mingle.store.quotaWait(peer.id)).toBeUndefined();
  });

  it("drops an inherited wait when a new session uses its own key", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    current = await rig(answeringUnless(state, inputs), {
      wrap: flaky(state, "quota", () => Date.now() + 1_800_000),
    });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Own key peer", role: "", harness: "scripted" });
    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    await mingle.setEnv(peer.id, "ANTHROPIC_API_KEY", "synthetic-key");
    expect(mingle.runtime(peer.id)?.limit).toBeUndefined();
    expect(mingle.store.quotaWait(peer.id)).toBeUndefined();
    expect(mingle.runtime(agentId)?.limit).toBeDefined();
  });

  it("releases the other waiting messages after one selected retry succeeds", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    current = await rig(answeringUnless(state, inputs), {
      wrap: flaky(state, "quota", () => Date.now() + 1_800_000),
    });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "first" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const first = mingle.store.waiting(agentId)[0]!;
    channel.receive({ text: "second" });
    await until(() => mingle.store.waiting(agentId).length === 2);
    const second = mingle.store.waiting(agentId).find((m) => m.id !== first.id)!;
    await until(() => !mingle.runtime(agentId)?.busy);
    await current.admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [first.id] });
    await until(() => mingle.store.message(first.id)?.state === "replied" && !mingle.runtime(agentId)?.busy);
    await until(() => mingle.store.message(second.id)?.state === "replied");
  });

  it("does not shorten a longer persisted shared wait during startup", async () => {
    current = await rig(async () => {});
    const { mingle, agentId } = current;
    const peer = mingle.createAgent({ name: "Longer wait", role: "", harness: "scripted" });
    const later = Date.now() + 2_400_000;
    mingle.store.setQuotaWait(agentId, { until: later - 1_200_000, resetsAt: later - 1_215_000 });
    mingle.store.setQuotaWait(peer.id, { until: later, resetsAt: later - 15_000 });
    const again = new Mingle(mingle.options);
    try {
      await again.start("http://127.0.0.1:1");
      expect(again.runtime(peer.id)?.limit?.until).toBe(later);
    } finally {
      await again.stop();
    }
  });
});

describe("the account limit ledger", () => {
  /** A fake chat app on another platform, so a second agent can have a connection of its own. */
  function channelOn(platform: string): FakeChannel {
    const channel = new FakeChannel();
    (channel as { platform: string }).platform = platform;
    return channel;
  }

  /** Records the events each new session gets, so a test can drive a turn itself. */
  function recorded(sessions: HarnessEvents[]) {
    return (harness: Harness): Harness => ({
      ...harness,
      open: (options, events) => {
        sessions.push(events);
        return harness.open(options, events);
      },
    });
  }

  /** Records every session open's options and events, so a test can inspect what the harness got. */
  function recording() {
    const opens: Parameters<Harness["open"]>[0][] = [];
    const sessions: HarnessEvents[] = [];
    const wrap =
      (next?: (harness: Harness) => Harness) =>
      (harness: Harness): Harness => {
        const inner = next ? next(harness) : harness;
        return {
          ...inner,
          open: (options, events) => {
            opens.push(options);
            sessions.push(events);
            return inner.open(options, events);
          },
        };
      };
    return { opens, sessions, wrap };
  }

  /**
   * Secrets whose reads can be held at a gate: a read captures its value, then waits. What a
   * blocked session open does with the stale value once the gate lifts is what the tests watch.
   */
  function gatedSecrets(inner: SecretStore) {
    const gate = Promise.withResolvers<void>();
    releaseGates.push(gate.resolve);
    let hold = false;
    let held = 0;
    const secrets: SecretStore = {
      ...inner,
      get: async (ref) => {
        const value = await inner.get(ref);
        if (hold) {
          held++;
          await gate.promise;
        }
        return value;
      },
    };
    return { secrets, gate, hold: (v: boolean) => (hold = v), held: () => held };
  }

  it.each(["peer", "agent"])("restores each sign-in's latest persisted wait at startup (%s held it)", async (who) => {
    current = await rig(async () => {});
    const { mingle, agentId } = current;
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });
    const later = Date.now() + 2_400_000;
    const [longer, shorter] = who === "peer" ? [peer.id, agentId] : [agentId, peer.id];
    mingle.store.setQuotaWait(longer, { until: later, resetsAt: later - 15_000 });
    mingle.store.setQuotaWait(shorter, { until: later - 1_200_000, resetsAt: later - 1_215_000 });
    const again = new Mingle(mingle.options);
    try {
      await again.start("http://127.0.0.1:1");
      for (const id of [agentId, peer.id]) {
        expect(again.runtime(id)?.limit?.until).toBe(later);
        expect(again.store.quotaWait(id)?.until).toBe(later);
      }
    } finally {
      await again.stop();
    }
  });

  it("keeps the wait when a newer quota report lands during a turn that then completes", async () => {
    const sessions: HarnessEvents[] = [];
    const state = { fails: 2 };
    const inputs: string[] = [];
    const early = Date.now() + 30 * 60_000;
    // The first quota report is the later deadline; the second is shorter, so the shared wait
    // must stay at the first one's deadline while still counting as a newer report.
    const resets = [early, early - 1_200_000];
    let reported = 0;
    const flakyHarness = flaky(state, "quota", () => resets[Math.min(reported++, resets.length - 1)] as number);
    const wrap = (harness: Harness): Harness => {
      const inner = flakyHarness(harness);
      return {
        ...inner,
        open: (options, events) => {
          sessions.push(events);
          return inner.open(options, events);
        },
      };
    };
    const peerChannel = channelOn("discord");
    current = await rig(answeringUnless(state, inputs), { wrap, channels: { discord: peerChannel } });
    const { mingle, channel, agentId } = current;
    // Sessions open eagerly when an agent is created: sessions[0] is Alex, sessions[1] the peer.
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });
    await mingle.addConnection(peer.id, "discord", { token: "fake" });

    channel.receive({ text: "first" });
    await until(() => mingle.store.waiting(agentId).length === 1 && sessions.length === 2);
    const until_ = early + 15_000;
    expect(mingle.store.quotaWait(agentId)?.until).toBe(until_);

    peerChannel.receive({ text: "peer" });
    await until(() => mingle.store.waiting(peer.id).length === 1);

    // Alex's session begins a turn under the first report.
    const alex = sessions[0] as HarnessEvents;
    alex.onTurnStarted();
    // Meanwhile Peer's owner retries: that turn fails with a NEWER quota report.
    await current.admin("POST", `/v1/admin/agents/${peer.id}/messages/retry`, {});
    await until(() => mingle.store.waiting(peer.id).length === 1 && !mingle.runtime(peer.id)?.busy);
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(until_);

    // Alex's turn completes: it began under the old report, so the newer wait stands.
    alex.onTurnEnded({ kind: "completed" });
    await until(() => !mingle.runtime(agentId)?.busy);
    expect(mingle.store.quotaWait(agentId)?.until).toBe(until_);
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(until_);
    expect(mingle.store.waiting(agentId)).toHaveLength(1);
    expect(mingle.store.waiting(peer.id)).toHaveLength(1);

    // A turn begun after the newer report completes: the account answers, everyone is released.
    alex.onTurnStarted();
    alex.onTurnEnded({ kind: "completed" });
    await until(() => mingle.store.waiting(agentId).length === 0 && mingle.store.waiting(peer.id).length === 0);
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    expect(mingle.store.quotaWait(peer.id)).toBeUndefined();
    expect(mingle.runtime(peer.id)?.limit).toBeUndefined();
  });

  it("keeps a busy session's quota on its old shared sign-in and replies on the new one", async () => {
    const sessions: HarnessEvents[] = [];
    const gated = gatedSecrets(memorySecrets());
    const state = { fails: 1 };
    const resetsAt = Date.now() + 1_800_000;
    const turn = Promise.withResolvers<void>();
    releaseGates.push(turn.resolve);
    const flakyHarness = flaky(state, "quota", () => resetsAt);
    const wrap = (harness: Harness): Harness => {
      const inner = flakyHarness(harness);
      return {
        ...inner,
        open: (options, events) => {
          sessions.push(events);
          return inner.open(options, events);
        },
      };
    };
    const inputs: string[] = [];
    current = await rig(
      async (t) => {
        if (t.input.includes("hold on")) await turn.promise;
        await answeringUnless(state, inputs)(t);
      },
      { wrap, secrets: gated.secrets },
    );
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });

    channel.receive({ text: "hold on" });
    await until(() => mingle.runtime(agentId)?.busy);
    // Another message is steered into the same turn: it ends up waiting on the shared account too.
    channel.receive({ text: "seed" });
    await until(() => mingle.store.undelivered(agentId).length === 0);
    // The credential change applies to the NEXT session; this turn still runs on the shared sign-in.
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key");
    // Its replacement session's env read is held, so the in-between state is stable to inspect.
    gated.hold(true);
    turn.resolve();
    await until(() => mingle.store.quotaWait(peer.id)?.until === resetsAt + 15_000);
    expect(mingle.runtime(peer.id)?.limit?.until).toBe(resetsAt + 15_000);
    await until(() => mingle.store.waiting(agentId).length === 2);

    // A timer must not resume either waiting message into the session still running on the scope
    // they are no longer in: the active sign-in is stale until the replacement opens.
    mingle.resumeWaiting(resetsAt + 16_000);
    expect(mingle.store.waiting(agentId)).toHaveLength(2);
    const held = mingle.store.waiting(agentId).map((m) => m.id);

    // The replacement opens on its own scope and delivers the ready messages there; the shared
    // wait the old session reported stays on the shared sign-in, holding only the peer.
    gated.gate.resolve();
    await until(() => sessions.length === 3 && !mingle.runtime(agentId)?.busy);
    for (const id of held) await until(() => mingle.store.message(id)?.state === "replied");
    expect(mingle.runtime(agentId)?.limit).toBeUndefined();
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(resetsAt + 15_000);
    expect(mingle.runtime(peer.id)?.limit?.until).toBe(resetsAt + 15_000);
  });

  it("does not spread an old own-key session's quota to the shared sign-in after deleting the key", async () => {
    const sessions: HarnessEvents[] = [];
    const state = { fails: 2 };
    const inputs: string[] = [];
    const sharedResets = Date.now() + 1_800_000;
    const ownResets = Date.now() + 2_700_000;
    const resets = [sharedResets, ownResets];
    let reported = 0;
    const flakyHarness = flaky(state, "quota", () => resets[Math.min(reported++, resets.length - 1)] as number);
    const wrap = (harness: Harness): Harness => {
      const inner = flakyHarness(harness);
      return {
        ...inner,
        open: (options, events) => {
          sessions.push(events);
          return inner.open(options, events);
        },
      };
    };
    const turn = Promise.withResolvers<void>();
    releaseGates.push(turn.resolve);
    const peerChannel = channelOn("discord");
    current = await rig(
      async (t) => {
        if (t.input.includes("hold on")) await turn.promise;
        await answeringUnless(state, inputs)(t);
      },
      { wrap, channels: { discord: peerChannel } },
    );
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });
    await mingle.addConnection(peer.id, "discord", { token: "fake" });
    const sharedUntil = sharedResets + 15_000;

    // The peer hits the shared account's limit first.
    peerChannel.receive({ text: "peer" });
    await until(() => mingle.store.waiting(peer.id).length === 1);
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(sharedUntil);

    // Alex moves to its own key, then begins a turn on it: sessions[2] runs on its own sign-in.
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key");
    await until(() => sessions.length === 3);
    channel.receive({ text: "hold on" });
    await until(() => mingle.runtime(agentId)?.busy);

    // The key is deleted mid-turn: Alex's next session falls back to the shared sign-in.
    await mingle.deleteEnv(agentId, "ANTHROPIC_API_KEY");
    expect(mingle.store.quotaWait(agentId)?.until).toBe(sharedUntil);

    // The running turn fails on its own key: that wait stays on that key and never reaches the peer.
    turn.resolve();
    await until(() => sessions.length === 4 && !mingle.runtime(agentId)?.busy);
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(sharedUntil);
    expect(mingle.runtime(peer.id)?.limit?.until).toBe(sharedUntil);
    // The replacement session is on the shared sign-in: it inherits the shared wait.
    expect(mingle.runtime(agentId)?.limit?.until).toBe(sharedUntil);
    expect(mingle.store.quotaWait(agentId)?.until).toBe(sharedUntil);
  });

  it("drops an own-key wait when the same credential name is saved again", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const resetsAt = Date.now() + 1_800_000;
    current = await rig(answeringUnless(state, inputs), { wrap: flaky(state, "quota", () => resetsAt) });
    const { mingle, channel, agentId } = current;
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key");
    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    expect(mingle.store.quotaWait(agentId)).toEqual({ until: resetsAt + 15_000, resetsAt });

    // Saving the same name again means new credentials: a fresh scope with no wait.
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key-2");
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    await until(
      () => mingle.store.waiting(agentId).length === 0 && channel.sent.length >= 1 && !mingle.runtime(agentId)?.busy,
    );
    expect(mingle.runtime(agentId)?.limit).toBeUndefined();
  });

  it("keeps the wait when an unrelated variable changes", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const resetsAt = Date.now() + 1_800_000;
    current = await rig(answeringUnless(state, inputs), { wrap: flaky(state, "quota", () => resetsAt) });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const wait = mingle.store.quotaWait(agentId) as { until: number; resetsAt: number | null };

    await mingle.setEnv(agentId, "UNRELATED_NAME", "x");
    expect(mingle.store.quotaWait(agentId)).toEqual(wait);
    await until(() => mingle.runtime(agentId)?.limit?.until === wait.until);
  });

  it("ignores own-key variables for a harness that cannot receive them", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const resetsAt = Date.now() + 1_800_000;
    current = await rig(answeringUnless(state, inputs), {
      wrap: (harness) => ({ ...flaky(state, "quota", () => resetsAt)(harness), acceptsEnv: () => false }),
    });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });
    await mingle.setEnv(peer.id, "ANTHROPIC_API_KEY", "synthetic-key");
    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    // The variable never reaches the harness: the peer still shares the computer's sign-in.
    expect(mingle.store.quotaWait(peer.id)).toEqual({ until: resetsAt + 15_000, resetsAt });
    expect(mingle.runtime(peer.id)?.limit?.until).toBe(resetsAt + 15_000);
  });

  it("ignores events from a session that was replaced", async () => {
    const sessions: HarnessEvents[] = [];
    const inputs: string[] = [];
    current = await rig(answering(inputs), { wrap: recorded(sessions) });
    const { mingle, channel, agentId } = current;
    channel.receive({ text: "hi" });
    await until(() => sessions.length === 1 && !mingle.runtime(agentId)?.busy);

    await mingle.updateAgent(agentId, { name: "Renamed" });
    await until(() => sessions.length === 2 && mingle.agent(agentId)?.status === "idle");

    // The retired session reports late: none of it may reach the new session or the ledger.
    const stale = sessions[0] as HarnessEvents;
    stale.onTurnStarted();
    stale.onActivity("tool", "stale work");
    stale.onTurnEnded({ kind: "failed", reason: "quota", failure: "quota", resetsAt: Date.now() + 1_800_000 });
    expect(mingle.runtime(agentId)?.limit).toBeUndefined();
    expect(mingle.runtime(agentId)?.busy).toBeFalsy();
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    expect(mingle.agent(agentId)?.status).toBe("idle");
  });

  it("keeps a disconnected chat's message waiting, ready at the reconnect", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const peerChannel = channelOn("discord");
    current = await rig(answeringUnless(state, inputs), {
      wrap: flaky(state, "quota", () => Date.now() + 1_800_000),
      channels: { discord: peerChannel },
    });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });
    await mingle.addConnection(peer.id, "discord", { token: "fake" });

    channel.receive({ text: "first" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const waiting = mingle.store.waiting(agentId)[0] as { id: string; retryAt: number };
    expect(waiting.retryAt).toBeGreaterThan(Date.now());

    // An ignored message stays ignored through the release.
    channel.receive({ text: "ignore me" });
    await until(() => mingle.store.waiting(agentId).length === 2);
    const ignored = mingle.store.waiting(agentId).find((m) => m.id !== waiting.id) as { id: string };
    await current.admin("POST", `/v1/admin/agents/${agentId}/messages/ignore`, { ids: [ignored.id] });
    expect(mingle.store.message(ignored.id)?.state).toBe("ignored");

    // The chat app drops and stays down.
    channel.connectFailures = 100;
    channel.report({ kind: "error", code: "network" });
    await until(() => mingle.store.connections(agentId)[0]?.state !== "connected");

    // A peer on the same sign-in retries and succeeds: the account wait ends for everyone.
    peerChannel.receive({ text: "peer" });
    await until(() => mingle.store.waiting(peer.id).length === 1);
    await until(() => !mingle.runtime(agentId)?.busy);
    await current.admin("POST", `/v1/admin/agents/${peer.id}/messages/retry`, {});
    await until(() => mingle.store.waiting(peer.id).length === 0 && peerChannel.sent.length >= 1);
    // The completing turn ends the account wait: cleared for every agent sharing the sign-in.
    await until(() => mingle.store.quotaWait(peer.id) === undefined);

    // Alex's message cannot be delivered while its chat is offline, but its retry time is already
    // past, so the next normal resume after reconnecting sends it — not the old deadline.
    const offline = mingle.store.message(waiting.id) as { state: string; retryAt: number };
    expect(offline.state).toBe("waiting");
    expect(offline.retryAt).toBeLessThanOrEqual(Date.now());
    expect(mingle.store.message(ignored.id)?.state).toBe("ignored");

    // The early retry time is persisted, not just in memory.
    const store2 = new Store(mingle.options.paths.db);
    try {
      const persisted = store2.message(waiting.id) as { state: string; retryAt: number };
      expect(persisted.state).toBe("waiting");
      expect(persisted.retryAt).toBeLessThanOrEqual(Date.now());
    } finally {
      store2.close();
    }

    channel.connectFailures = 0;
    await mingle.resume("the chat app is back");
    await until(() => mingle.store.message(waiting.id)?.state === "replied");
    expect(mingle.store.message(ignored.id)?.state).toBe("ignored");
  });

  it("restores a shared peer's wait at startup after the reporter moved to its own key", async () => {
    const state = { fails: 1 };
    const inputs: string[] = [];
    const resetsAt = Date.now() + 1_800_000;
    current = await rig(answeringUnless(state, inputs), { wrap: flaky(state, "quota", () => resetsAt) });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });
    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    const until_ = resetsAt + 15_000;
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(until_);

    // The reporter moves to its own scope: only the peer still carries the shared wait.
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key");
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    const again = new Mingle(mingle.options);
    try {
      await again.start("http://127.0.0.1:1");
      expect(again.runtime(peer.id)?.limit?.until).toBe(until_);
      expect(again.store.quotaWait(peer.id)?.until).toBe(until_);
    } finally {
      await again.stop();
    }
  });

  it("re-scopes the persisted wait when the harness changes to one that ignores variables", async () => {
    const state = { fails: 2 };
    const inputs: string[] = [];
    const sharedResets = Date.now() + 1_800_000;
    const ownResets = Date.now() + 2_700_000;
    const resets = [sharedResets, ownResets];
    let reported = 0;
    const peerChannel = channelOn("discord");
    current = await rig(answeringUnless(state, inputs), {
      wrap: (harness) => ({
        ...flaky(state, "quota", () => resets[Math.min(reported++, resets.length - 1)] as number)(harness),
        acceptsEnv: (id: string) => id !== "noenv",
      }),
      channels: { discord: peerChannel },
    });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Peer", role: "", harness: "scripted" });
    await mingle.addConnection(peer.id, "discord", { token: "fake" });
    const sharedUntil = sharedResets + 15_000;

    // The shared account runs out first, then Alex on its own key.
    peerChannel.receive({ text: "peer" });
    await until(() => mingle.store.waiting(peer.id).length === 1);
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(sharedUntil);
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key");
    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    expect(mingle.store.quotaWait(agentId)?.until).toBe(ownResets + 15_000);

    // The new harness cannot take the agent's variables: its sign-in is this computer's again,
    // a fresh scope, so the old own-key wait leaves the database and the gate.
    await mingle.updateAgent(agentId, { harness: "noenv" });
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    await until(() => mingle.runtime(agentId)?.limit === undefined);
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(sharedUntil);
    expect(mingle.runtime(peer.id)?.limit?.until).toBe(sharedUntil);
    // Its waiting message retries on the new harness and is answered.
    await until(() => mingle.store.waiting(agentId).length === 0 && channel.sent.length >= 1);
  });

  it("never hands the harness credentials read under a different sign-in", async () => {
    const gated = gatedSecrets(memorySecrets());
    const state = { fails: 1 };
    const { opens, wrap } = recording();
    const inputs: string[] = [];
    const flakyHarness = flaky(state, "quota", () => Date.now() + 1_800_000);
    current = await rig(answeringUnless(state, inputs), { wrap: wrap(flakyHarness), secrets: gated.secrets });
    const { mingle, channel, agentId } = current;
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key-A");
    await until(() => opens.length === 2);

    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    expect(mingle.store.quotaWait(agentId)).toBeDefined();

    // A refresh's env read captures A, then blocks; meanwhile the owner replaces it with B.
    gated.hold(true);
    const refreshing = mingle.runtime(agentId)?.refresh();
    await until(() => gated.held() === 1);
    const switching = mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key-B");
    gated.gate.resolve();
    await switching;
    await refreshing;
    await until(() => opens.length >= 3 && !mingle.runtime(agentId)?.busy);

    // The stale read was thrown away with the sign-in it belonged to: every session opened
    // since runs on B. The old scope's quota wait never reaches them.
    for (const open of opens.slice(2)) expect(open.env.ANTHROPIC_API_KEY).toBe("synthetic-key-B");
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    expect(mingle.runtime(agentId)?.limit).toBeUndefined();
  });

  it("drops a session open still reading secrets when the agent is paused", async () => {
    const gated = gatedSecrets(memorySecrets());
    const { opens, wrap } = recording();
    current = await rig(async () => {}, { wrap: wrap(), secrets: gated.secrets });
    const { mingle, agentId } = current;
    await mingle.setEnv(agentId, "ANTHROPIC_API_KEY", "synthetic-key");
    await until(() => opens.length === 2);

    gated.hold(true);
    const refreshing = mingle.runtime(agentId)?.refresh();
    await until(() => gated.held() === 1);
    // Pausing waits for the open to settle: release the read and let the disposed opener die.
    const pausing = mingle.pauseAgent(agentId);
    gated.gate.resolve();
    await pausing;
    await refreshing;

    // The disposed opener never reached the harness and changes nothing afterwards.
    expect(opens).toHaveLength(2);
    expect(mingle.runtime(agentId)).toBeUndefined();
    expect(mingle.store.agent(agentId)?.status).toBe("paused");
  });

  it("delivers a manual retry on the reopened session and releases the other waiting", async () => {
    const { opens, wrap } = recording();
    let refuse = true;
    const inputs: string[] = [];
    current = await rig(answering(inputs), {
      wrap: wrap((harness) => ({
        ...harness,
        open: async (options, events) => {
          const session = await harness.open(options, events);
          return {
            ...session,
            deliver: async (text: string, inputId: string) => {
              if (refuse) {
                refuse = false;
                throw new HarnessError("quota", "usage limit exceeded");
              }
              return session.deliver(text, inputId);
            },
          };
        },
      })),
    });
    const { mingle, channel, agentId } = current;

    // The first delivery is refused with quota: the session itself is dropped, the wait is shared.
    channel.receive({ text: "first" });
    await until(() => mingle.store.waiting(agentId).length === 1 && mingle.store.agent(agentId)?.status === "error");
    channel.receive({ text: "second" });
    await until(() => mingle.store.waiting(agentId).length === 2);
    const waiting = mingle.store.waiting(agentId);
    const first = waiting[0] as { id: string };
    const second = waiting.find((m) => m.id !== first.id) as { id: string };

    // The selected retry reopens on the same sign-in, is not re-blocked by the shared wait,
    // and its success ends the wait for the rest.
    await current.admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, { ids: [first.id] });
    await until(() => mingle.store.message(first.id)?.state === "replied" && !mingle.runtime(agentId)?.busy);
    await until(() => mingle.store.message(second.id)?.state === "replied");
    expect(mingle.store.quotaWait(agentId)).toBeUndefined();
    expect(opens.length).toBeGreaterThanOrEqual(2);
  });

  it("releases a shared wait without waking a paused peer", async () => {
    const sessions: HarnessEvents[] = [];
    const state = { fails: 1 };
    const inputs: string[] = [];
    const resetsAt = Date.now() + 1_800_000;
    const flakyHarness = flaky(state, "quota", () => resetsAt);
    current = await rig(answeringUnless(state, inputs), {
      wrap: (harness) => {
        const inner = flakyHarness(harness);
        return {
          ...inner,
          open: (options: Parameters<Harness["open"]>[0], events: HarnessEvents) => {
            sessions.push(events);
            return inner.open(options, events);
          },
        };
      },
    });
    const { mingle, channel, agentId } = current;
    const peer = mingle.createAgent({ name: "Paused peer", role: "", harness: "scripted" });
    await mingle.pauseAgent(peer.id);

    channel.receive({ text: "quota" });
    await until(() => mingle.store.waiting(agentId).length === 1);
    expect(mingle.store.quotaWait(peer.id)?.until).toBe(resetsAt + 15_000);
    const opened = sessions.length;

    await until(() => !mingle.runtime(agentId)?.busy);
    await current.admin("POST", `/v1/admin/agents/${agentId}/messages/retry`, {});
    await until(() => mingle.store.waiting(agentId).length === 0 && !mingle.runtime(agentId)?.busy);

    // Releasing the shared wait opened no session for the paused peer.
    expect(sessions.length).toBe(opened);
    expect(mingle.store.agent(peer.id)?.status).toBe("paused");
    await until(() => mingle.store.quotaWait(peer.id) === undefined);
    await mingle.resumeAgent(peer.id);
    expect(mingle.runtime(peer.id)?.limit).toBeUndefined();
  });
});
