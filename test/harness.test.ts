import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AvailableInstallation,
  createCursorRuntime,
  defaultRuntimes,
  type Runtime,
  type Session,
  UnsupportedOptionError,
} from "@botiverse/oar";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oarHarness } from "../src/harness/harness.ts";

const PROMPT = "Mingle test instructions";
const ENV = { MINGLE_TEST: "present" };

const events = { onTurnStarted() {}, onTurnEnded() {}, onActivity() {} };

let home = "";
afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});
const cwd = () => (home ||= mkdtempSync(join(tmpdir(), "mingle-harness-test-")));

const executable = (version?: string): AvailableInstallation => ({
  kind: "available",
  via: "executable",
  command: "opencode",
  ...(version !== undefined ? { version } : {}),
});

/** A session record the harness can drive without a real binary. */
const fakeSession = (id = "s-fixture") =>
  ({
    id,
    events: () => () => {},
    deliver: async () => ({ landed: "prompted" }),
    abort: async () => {},
    dispose: async () => {},
  }) as unknown as Session;

/** The real opencode runtime with a synthetic installed version and a stubbed session. */
function opencodeAt(version: string | undefined, session?: Runtime["session"]) {
  const base = defaultRuntimes.require("opencode");
  const sessionSpy = vi.fn(session ?? (async () => fakeSession()));
  const runtime: Runtime = {
    ...base,
    installation: async () => executable(version),
    session: sessionSpy,
  };
  return { runtime, sessionSpy };
}

const open = (id: string, runtime: Runtime, resume?: string) =>
  oarHarness({ require: () => runtime }).open(
    { harness: id, cwd: cwd(), appendSystemPrompt: PROMPT, env: ENV, ...(resume ? { resume } : {}) },
    events,
  );

describe("opencode version gate", () => {
  it.each(["1.19.5", "opencode v1.19.5", "1.19.5-beta.1"])("enables OpenCode %s", async (version) => {
    const { runtime } = opencodeAt(version);
    const list = await oarHarness({ require: () => runtime }).available();
    expect(list.find((h) => h.id === "opencode")?.disabled).toBeUndefined();
  });

  it.each(["opencode v2.0.0", "2.1.0", "3.0.0", "development", undefined])(
    "lists OpenCode %s as disabled but visible",
    async (version) => {
      const { runtime } = opencodeAt(version);
      const list = await oarHarness({ require: () => runtime }).available();
      const entry = list.find((h) => h.id === "opencode");
      expect(entry?.disabled?.code).toBe("harness_opencode_version");
      expect(entry?.disabled?.reason).toContain("OpenCode 1.x");
    },
  );

  it("blocks models and open on a disabled version before either is asked", async () => {
    const { runtime, sessionSpy } = opencodeAt("2.0.0");
    const listModels = vi.fn();
    const blocked: Runtime = { ...runtime, listModels: listModels as unknown as NonNullable<Runtime["listModels"]> };
    const harness = oarHarness({ require: () => blocked });
    await expect(harness.models?.("opencode")).rejects.toMatchObject({ code: "harness_opencode_version" });
    await expect(open("opencode", blocked)).rejects.toMatchObject({ code: "harness_opencode_version" });
    await expect(open("opencode", blocked, "s-old")).rejects.toMatchObject({ code: "harness_opencode_version" });
    expect(listModels).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("opens 1.x with Mingle's prompt, env and model unchanged", async () => {
    const { runtime, sessionSpy } = opencodeAt("1.19.5");
    const session = await oarHarness({ require: () => runtime }).open(
      { harness: "opencode", cwd: cwd(), appendSystemPrompt: PROMPT, env: ENV, model: "m-1" },
      events,
    );
    expect(session.id).toBe("s-fixture");
    expect(session.resumed).toBe(false);
    expect(sessionSpy).toHaveBeenCalledOnce();
    const options = sessionSpy.mock.calls[0]?.[1];
    expect(options?.appendSystemPrompt).toBe(PROMPT);
    expect(options?.env).toEqual(ENV);
    expect(options?.model).toBe("m-1");
  });

  it("resumes when the harness still has the session", async () => {
    const { runtime, sessionSpy } = opencodeAt("1.19.5");
    const session = await open("opencode", runtime, "s-old");
    expect(session.resumed).toBe(true);
    expect(sessionSpy.mock.calls[0]?.[1]?.resume).toBe("s-old");
  });

  it("falls back to a fresh session only on SessionNotFoundError", async () => {
    const gone = Object.assign(new Error("gone"), { name: "SessionNotFoundError" });
    const sessionSpy = vi.fn().mockRejectedValueOnce(gone).mockResolvedValueOnce(fakeSession("s-new"));
    const { runtime } = opencodeAt("1.19.5", sessionSpy);
    const session = await open("opencode", runtime, "s-old");
    expect(session.resumed).toBe(false);
    expect(session.id).toBe("s-new");
    expect(sessionSpy).toHaveBeenCalledTimes(2);
    expect(sessionSpy.mock.calls[1]?.[1]?.resume).toBeUndefined();

    const other = new Error("fixture network failure");
    const failing = vi.fn().mockRejectedValue(other);
    const { runtime: down } = opencodeAt("1.19.5", failing);
    await expect(open("opencode", down, "s-old")).rejects.toBe(other);
    expect(failing).toHaveBeenCalledOnce(); // No fallback on other errors.
  });

  it("re-probes at open: a 1.x -> 2.x upgrade after listing blocks the next session", async () => {
    let version: string | undefined = "1.19.5";
    const base = defaultRuntimes.require("opencode");
    const sessionSpy = vi.fn(async () => fakeSession());
    const runtime: Runtime = { ...base, installation: async () => executable(version), session: sessionSpy };
    const harness = oarHarness({ require: () => runtime });
    expect((await harness.available()).find((h) => h.id === "opencode")?.disabled).toBeUndefined();
    version = "2.0.0";
    await expect(open("opencode", runtime)).rejects.toMatchObject({ code: "harness_opencode_version" });
    expect(sessionSpy).not.toHaveBeenCalled();
  });
});

describe("declared option refusals", () => {
  const refused = (options: Record<string, string>) => {
    const runtime = {
      ...scriptedRuntime({ id: "codex", turn: () => {} }),
      refusedSessionOptions: options,
    } as Runtime;
    return runtime;
  };

  it("blocks a runtime that refuses appendSystemPrompt", async () => {
    const runtime = refused({ appendSystemPrompt: "fixture refusal" });
    const harness = oarHarness({ require: () => runtime });
    const entry = (await harness.available()).find((h) => h.id === "codex");
    expect(entry?.disabled?.code).toBe("harness_prompt_unsupported");
    await expect(open("codex", runtime)).rejects.toMatchObject({ code: "harness_prompt_unsupported" });
  });

  it("blocks a runtime that refuses env", async () => {
    const runtime = refused({ env: "fixture refusal" });
    const entry = (await oarHarness({ require: () => runtime }).available()).find((h) => h.id === "codex");
    expect(entry?.disabled?.code).toBe("harness_env_unsupported");
    await expect(open("codex", runtime)).rejects.toMatchObject({ code: "harness_env_unsupported" });
  });

  it("does not block a refusal Mingle never sends", async () => {
    const runtime = refused({ outputSchema: "fixture refusal" });
    const entry = (await oarHarness({ require: () => runtime }).available()).find((h) => h.id === "codex");
    expect(entry?.disabled).toBeUndefined();
    const session = await open("codex", runtime);
    expect(session.id).toBeTruthy();
    await session.dispose();
  });

  it("marks the real cursor runtime disabled from its own public declaration", async () => {
    // Cursor is not in the default registry; its public constructor declares the refusals.
    const cursor = createCursorRuntime({ sdk: {} as never });
    const sessionSpy = vi.fn(async () => fakeSession());
    const runtime: Runtime = {
      ...cursor,
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: sessionSpy,
    };
    const harness = oarHarness({ require: () => runtime });
    const entry = (await harness.available()).find((h) => h.id === "cursor");
    expect(entry?.disabled?.code).toBe("harness_prompt_unsupported");
    await expect(open("cursor", runtime)).rejects.toMatchObject({ code: "harness_prompt_unsupported" });
    expect(sessionSpy).not.toHaveBeenCalled();
  });
});

describe("undeclared open-time refusals", () => {
  const failing = (error: Error) => {
    const runtime = {
      ...scriptedRuntime({ id: "flaky", turn: () => {} }),
      session: vi.fn(async () => {
        throw error;
      }),
    } as Runtime;
    return runtime;
  };

  it("translates an UnsupportedOptionError into harness_incompatible", async () => {
    const runtime = failing(new UnsupportedOptionError("appendSystemPrompt", "fixture refusal"));
    await expect(open("flaky", runtime)).rejects.toMatchObject({
      code: "harness_incompatible",
      next: "This harness cannot apply the settings Mingle needs. Choose another harness.",
    });
  });

  it("keeps an ordinary failure as itself, not mislabeled unsupported", async () => {
    const error = new Error("fixture network failure");
    const runtime = failing(error);
    await expect(open("flaky", runtime)).rejects.toBe(error);
  });
});
