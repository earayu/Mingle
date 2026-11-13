import { describe, expect, it } from "vitest";
import { Brains } from "../src/core/brains.ts";
import type { Harness } from "../src/harness/harness.ts";
import { until } from "./helpers.ts";

function fakeHarness(): Harness & { installs: string[] } {
  const installs: string[] = [];
  return {
    installs,
    available: async () => [],
    open: async () => {
      throw new Error("not used");
    },
    install: async (id) => {
      installs.push(id);
      return id === "broken" ? { ok: false, detail: "npm ERR! 404" } : { ok: true };
    },
    signIn: async (_id, interaction) => {
      interaction.onEvent({ kind: "url", url: "https://example.com/login" });
      const code = await interaction.prompt({ message: "Paste the code", secret: true });
      return code === "123" ? { ok: true } : { ok: false, detail: "rejected" };
    },
  };
}

describe("harness installs and sign-ins", () => {
  it("installs once per harness and reports the outcome", async () => {
    const harness = fakeHarness();
    let changed = 0;
    const brains = new Brains(harness, () => changed++);
    const job = brains.install("dsh");
    expect(brains.install("dsh").id).toBe(job.id); // a second click shows the first
    await until(() => brains.get(job.id).state === "done");
    expect(harness.installs).toEqual(["dsh"]);
    expect(changed).toBe(1);
    const failed = brains.install("broken");
    await until(() => brains.get(failed.id).state === "failed");
    expect(brains.get(failed.id).detail).toBe("npm ERR! 404");
    brains.dispose();
  });

  it("signs in through a link and a code the person types back", async () => {
    const brains = new Brains(fakeHarness(), () => {});
    const job = brains.signIn("claude");
    await until(() => brains.get(job.id).prompt);
    expect(brains.get(job.id)).toMatchObject({
      state: "running",
      events: [{ kind: "url", url: "https://example.com/login" }],
      prompt: { message: "Paste the code", secret: true },
    });
    brains.answer(job.id, "123");
    await until(() => brains.get(job.id).state === "done");
    expect(brains.get(job.id).prompt).toBeUndefined();

    const cancelled = brains.signIn("codex");
    await until(() => brains.get(cancelled.id).prompt);
    brains.cancel(cancelled.id);
    expect(brains.get(cancelled.id).state).toBe("cancelled");
    expect(() => brains.answer("nope", "x")).toThrow();
    brains.dispose();
  });
});
