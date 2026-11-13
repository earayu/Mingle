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

describe("harness list", () => {
  it("probes every harness side by side and keeps the display order", async () => {
    let running = 0;
    let peak = 0;
    const delays: Record<string, number> = { claude: 60, codex: 10 };
    const source = {
      require: (id: string): Runtime => {
        if (id !== "claude" && id !== "codex") throw new Error("not offered here");
        return {
          ...defaultRuntimes.require(id),
          installation: async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((r) => setTimeout(r, delays[id]));
            running--;
            return { kind: "available", via: "executable", command: id, version: "1.2.3" };
          },
        };
      },
    };
    const list = await oarHarness(source).available();
    expect(peak).toBe(2);
    expect(list.map((h) => h.id)).toEqual(["claude", "codex"]);
    expect(list[0]?.version).toBe("1.2.3");
  });
});

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

  /** A runtime refusing `options`, recording what it was opened with and what it was sent. */
  const recording = (options: Record<string, string>) => {
    const opened: Record<string, unknown>[] = [];
    const sent: string[] = [];
    const runtime = {
      ...scriptedRuntime({ id: "codex", turn: () => {} }),
      refusedSessionOptions: options,
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: async (_install: unknown, sessionOptions: Record<string, unknown>) => {
        opened.push(sessionOptions);
        return {
          ...fakeSession(),
          deliver: async (text: string) => {
            sent.push(text);
            return { landed: "prompted" };
          },
        } as unknown as Session;
      },
    } as unknown as Runtime;
    return { runtime, opened, sent };
  };

  it("carries the guide in the first message when the harness refuses an appended prompt", async () => {
    const { runtime, opened, sent } = recording({ appendSystemPrompt: "fixture refusal" });
    const entry = (await oarHarness({ require: () => runtime }).available()).find((h) => h.id === "codex");
    expect(entry?.disabled).toBeUndefined();
    const session = await open("codex", runtime);
    expect(opened[0]).not.toHaveProperty("appendSystemPrompt");
    expect(opened[0]?.env).toEqual(ENV);
    await session.deliver("hello", "i1");
    await session.deliver("again", "i2");
    expect(sent[0]).toContain(PROMPT.trim());
    expect(sent[0]?.endsWith("hello")).toBe(true);
    expect(sent[1]).toBe("again"); // only once
  });

  it("writes the CLI's settings into the guide when the harness refuses an environment", async () => {
    const { runtime, opened, sent } = recording({ appendSystemPrompt: "fixture", env: "fixture refusal" });
    const session = await open("codex", runtime);
    expect(opened[0]).not.toHaveProperty("env");
    await session.deliver("hello", "i1");
    for (const [key, value] of Object.entries(ENV).filter(([k]) => k.startsWith("MINGLE_"))) {
      expect(sent[0]).toContain(`${key}='${value}'`);
    }
  });

  it("does not repeat the guide in a resumed session", async () => {
    const { runtime, sent } = recording({ appendSystemPrompt: "fixture refusal" });
    const session = await open("codex", runtime, "s-old");
    expect(session.resumed).toBe(true);
    await session.deliver("hello", "i1");
    expect(sent[0]).toBe("hello");
  });

  it("does not block a refusal Mingle never sends", async () => {
    const runtime = refused({ outputSchema: "fixture refusal" });
    const entry = (await oarHarness({ require: () => runtime }).available()).find((h) => h.id === "codex");
    expect(entry?.disabled).toBeUndefined();
    const session = await open("codex", runtime);
    expect(session.id).toBeTruthy();
    await session.dispose();
  });

  it("offers the real cursor runtime despite its declared refusals", async () => {
    // Cursor is not in the default registry; its public constructor declares the refusals.
    const cursor = createCursorRuntime({ sdk: {} as never });
    const sessionSpy = vi.fn(async () => fakeSession());
    const runtime: Runtime = {
      ...cursor,
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: sessionSpy,
    };
    const harness = oarHarness({ require: () => runtime });
    expect((await harness.available()).find((h) => h.id === "cursor")?.disabled).toBeUndefined();
    await open("cursor", runtime);
    const opened = (sessionSpy.mock.calls[0] as unknown[] | undefined)?.[1];
    expect(opened).not.toHaveProperty("appendSystemPrompt");
    expect(opened).not.toHaveProperty("env");
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
