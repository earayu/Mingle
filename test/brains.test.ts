import { describe, expect, it } from "vitest";
import { Brains, type JobView } from "../src/core/brains.ts";
import type { Harness } from "../src/harness/harness.ts";
import { rig, until } from "./helpers.ts";

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
    expect(brains.activeInstall("claude")).toBeUndefined();
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

  // A page that lost its job id finds the running install back through the catalog.
  it.each(["done", "failed"] as const)("reports a running install on GET /v1/admin/brains (%s)", async (outcome) => {
    let finish!: (result: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>((resolve) => {
      finish = resolve;
    });
    let installed = false;
    let calls = 0;
    const r = await rig(async () => {}, {
      wrap: (harness) => ({
        ...harness,
        catalog: async () => [
          {
            id: "install-test",
            name: "Install Test",
            installed,
            canInstall: true,
            canSignIn: false,
          },
          { id: "other-test", name: "Other Test", installed: false, canInstall: true, canSignIn: false },
        ],
        install: async () => {
          calls++;
          return await pending;
        },
      }),
    });
    try {
      const before = (await r.admin("GET", "/v1/admin/brains")).json as { id: string; installJob?: JobView }[];
      expect(before.every((b) => b.installJob === undefined)).toBe(true);

      const started = (await r.admin("POST", "/v1/admin/brains/install-test/install")).json as JobView;
      expect(started).toMatchObject({ kind: "install", harness: "install-test", state: "running" });

      // A fresh page has no job id; the catalog itself must carry the running install.
      const during = (await r.admin("GET", "/v1/admin/brains")).json as { id: string; installJob?: JobView }[];
      const first = during.find((b) => b.id === "install-test");
      expect(first?.installJob).toMatchObject({
        id: started.id,
        kind: "install",
        harness: "install-test",
        state: "running",
      });
      expect(during.find((b) => b.id === "other-test")?.installJob).toBeUndefined();

      // A repeated POST returns the same job instead of starting a second install.
      const again = (await r.admin("POST", "/v1/admin/brains/install-test/install")).json as JobView;
      expect(again.id).toBe(started.id);
      expect(calls).toBe(1);

      expect(r.mingle.brains.activeInstall("install-test")?.id).toBe(started.id);
      expect(r.mingle.brains.activeInstall("other-test")).toBeUndefined();

      installed = outcome === "done";
      finish({ ok: installed });
      await until(() => r.mingle.brains.get(started.id).state === outcome);

      const after = (await r.admin("GET", "/v1/admin/brains")).json as {
        id: string;
        installed: boolean;
        installJob?: JobView;
      }[];
      expect(after.every((b) => b.installJob === undefined)).toBe(true);
      expect(after.find((b) => b.id === "install-test")?.installed).toBe(installed);

      const job = (await r.admin("GET", `/v1/admin/jobs/${started.id}`)).json as JobView;
      expect(job.state).toBe(outcome);
    } finally {
      finish({ ok: false });
      await r.close();
    }
  });
});
