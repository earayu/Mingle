import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_LIMIT } from "../src/core/home.ts";
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
