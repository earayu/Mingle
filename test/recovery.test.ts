import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_LIMIT } from "../src/core/home.ts";
import { holdUntil } from "../src/core/runtime.ts";
import type { Failure, Harness } from "../src/harness/harness.ts";
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
    await until(() => inputs.some((i) => i.startsWith("[mingle] Your MEMORY.md is 36 KB")));
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
    const after = mingle.store.agent(agentId)?.sessionId;
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);

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
