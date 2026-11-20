import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/**
 * A follow-up from the person the running turn is handling goes into that turn (docs/rfc/0001 3.5,
 * docs/rfc/0001-implementation.md 4): steered in like a chat message, and handed over again once
 * when the turn ended too soon after it to have read it. Nobody else's words are steered in.
 */
describe("steering a follow-up into the running turn", () => {
  let current: Rig | undefined;
  afterEach(async () => {
    await current?.close();
    current = undefined;
  });

  const hearing = { quietMs: 150, maxWaitMs: 2_000, gapMs: 60_000 };
  const engage = {
    turnEnd: { k: 2, minMs: 100, maxMs: 300, defaultMs: 200, samples: 20, gapCapMs: 30_000 },
    fastMaxWaitMs: 1_000,
    steerQuietMs: 100,
    steerLateMs: 400,
    rideHoldMs: 300,
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const env = (t: ScriptedTurn) => t.options.env as Record<string, string>;

  /** The agent answers what is addressed to it once `hold` lets it; what it only heard, it leaves be. */
  async function setup(hold: (t: ScriptedTurn) => Promise<void>, log?: (line: string) => void) {
    current = await rig(
      async (t) => {
        if (t.input.includes("[mingle] Heard in")) return;
        for (const id of messageIds(t.input)) await runCli(env(t), ["message", "reply", id], "on it");
        await hold(t);
      },
      { hearing, engage, ...(log ? { log } : {}) },
    );
    return current;
  }

  const steeredHeard = (r: Rig) => r.turns[0]?.steered.filter((s) => s.includes("[mingle] Heard in")) ?? [];

  it("steers in what the person it is handling adds, as part of their conversation", async () => {
    const started = Promise.withResolvers<void>();
    const r = await setup(async (t) => {
      started.resolve();
      await t.tool("Bash", "sleep", () => sleep(1_200));
    });
    r.channel.receive({ text: "plan the route for Sunday" });
    await started.promise;
    r.channel.receive({ text: "make it Saturday, not Sunday", addressedToBot: false });
    await until(() => steeredHeard(r).length === 1, 5_000);
    const steered = steeredHeard(r)[0] ?? "";
    expect(steered).toMatch(/^\[mingle\] Heard in c\w+: 1 message\. You are in a conversation here with Zhang San/);
    expect(steered).toContain("make it Saturday, not Sunday");
    // Read in time: the turn ran on long after it, so it is not handed over again.
    await sleep(1_500);
    expect(r.turns).toHaveLength(1);
  });

  it("leaves what anyone else says for after the turn", async () => {
    const started = Promise.withResolvers<void>();
    const r = await setup(async (t) => {
      started.resolve();
      await t.tool("Bash", "sleep", () => sleep(800));
    });
    r.channel.receive({ text: "plan the route for Sunday" });
    await started.promise;
    r.channel.receive({
      text: "lunch anyone?",
      addressedToBot: false,
      sender: { id: "u2", name: "Li Si", isBot: false },
    });
    await until(() => r.turns.length === 2, 5_000);
    expect(r.turns[0]?.steered.join("\n")).not.toContain("lunch anyone?");
    expect(r.turns[1]?.input).toContain("lunch anyone?");
    expect(r.turns[1]?.input).toContain("none addressed to you");
  });

  it("hands a follow-up steered in as the turn ended over again, once", async () => {
    const lines: string[] = [];
    const r = await setup(
      async (t) => {
        // Ends the moment the follow-up is in, without a word on it: it may never have been read.
        await until(() => t.steered.length > 0, 5_000);
      },
      (line) => lines.push(line),
    );
    r.channel.receive({ text: "plan the route for Sunday" });
    // Its "on it" is out: nothing it says after this answers the follow-up.
    await until(() => r.channel.sent.length === 1);
    r.channel.receive({ text: "make it Saturday, not Sunday", addressedToBot: false });
    await until(() => r.turns.length === 2, 5_000);
    expect(r.turns[1]?.input).toMatch(/^\[mingle\] Heard in c\w+: 1 message\. You are in a conversation here/);
    expect(r.turns[1]?.input).toContain("make it Saturday, not Sunday");
    expect(lines.some((l) => / heard c\w+ steer: the turn ended .*, handing it over again$/.test(l))).toBe(true);
    // Handed over again as a fast stretch, which is settled as usual: no third time.
    await until(() => lines.some((l) => / heard c\w+ fast: /.test(l)), 5_000);
    await sleep(800);
    expect(r.turns).toHaveLength(2);
  });

  it("does not hand a follow-up over again once the agent muted the group", async () => {
    const lines: string[] = [];
    const r = await setup(
      async (t) => {
        await until(() => t.steered.length > 0, 5_000);
        // Steered in, then the agent mutes the group and the turn ends at once, without a word on it.
        const chat = /Heard in (c\w+)/.exec(t.steered.join("\n"))?.[1] as string;
        await runCli(env(t), ["chat", "hear", chat, "--mute"]);
      },
      (line) => lines.push(line),
    );
    r.channel.receive({ text: "plan the route for Sunday" });
    await until(() => r.channel.sent.length === 1);
    r.channel.receive({ text: "make it Saturday, not Sunday", addressedToBot: false });
    await until(() => lines.some((l) => / hears nothing until addressed$/.test(l)), 5_000);
    await sleep(1_000);
    expect(r.turns).toHaveLength(1);
    expect(lines.some((l) => /handing it over again$/.test(l))).toBe(false);
  });

  it("does not hand it over again when the turn ran on after it", async () => {
    const lines: string[] = [];
    const r = await setup(
      async (t) => {
        await until(() => t.steered.length > 0, 5_000);
        await t.tool("Bash", "sleep", () => sleep(700));
      },
      (line) => lines.push(line),
    );
    r.channel.receive({ text: "plan the route for Sunday" });
    // Its "on it" is out: nothing it says after this answers the follow-up.
    await until(() => r.channel.sent.length === 1);
    r.channel.receive({ text: "make it Saturday, not Sunday", addressedToBot: false });
    await until(() => lines.some((l) => / heard c\w+ steer: 1 message/.test(l)), 5_000);
    await sleep(500);
    expect(r.turns).toHaveLength(1);
  });
});
