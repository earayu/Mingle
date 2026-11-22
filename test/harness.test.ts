import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AvailableInstallation,
  createCursorRuntime,
  defaultRuntimes,
  type EventObserver,
  type Runtime,
  type RuntimeEventBody,
  type Session,
  UnsupportedOptionError,
} from "@botiverse/oar";
import { createSessionKernel } from "@botiverse/oar/kernel";
import { eventsOf, promptAndWait, usageOf } from "@botiverse/oar/observe";
import { scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { oarHarness, usageWindows } from "../src/harness/harness.ts";

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

  it("offers Devin and Factory Droid as usable harnesses, after the others", async () => {
    const installed = (id: string): Runtime => ({
      ...defaultRuntimes.require(id),
      installation: async () => ({ kind: "available", via: "executable", command: id, version: "1.0.0" }),
    });
    const runtimes = ["factory", "devin", "claude"].map(installed);
    const source = {
      require: (id: string): Runtime => {
        const found = runtimes.find((r) => r.id === id);
        if (!found) throw new Error("not offered here");
        return found;
      },
      list: () => runtimes,
    };
    const list = await oarHarness(source).available();
    expect(list.map((h) => h.id)).toEqual(["claude", "devin", "factory"]);
    for (const entry of list) expect(entry.disabled).toBeUndefined();
    // Devin takes the environment but not an appended prompt; Factory Droid takes both.
    expect(list.find((h) => h.id === "devin")?.noEnv).toBeUndefined();
    expect(list.find((h) => h.id === "factory")?.noEnv).toBeUndefined();
    expect(list.find((h) => h.id === "factory")?.icon).toBeDefined();
  });

  /** CodeBuddy whose probe answers from `answers` in turn, found at a real file. */
  function flaky(answers: ("found" | "missed" | "timeout" | "refused")[]) {
    const command = join(cwd(), "codebuddy.cmd");
    writeFileSync(command, "");
    let calls = 0;
    const runtime: Runtime = {
      ...defaultRuntimes.require("codebuddy"),
      installation: async () => {
        const answer = answers[Math.min(calls++, answers.length - 1)];
        if (answer === "timeout") throw new Error("Failed to run codebuddy.cmd --help: timeout after 15000 ms");
        if (answer === "missed") return { kind: "not_found" };
        if (answer === "refused") return { kind: "unsupported", reason: "--help failed" };
        return { kind: "available", via: "executable", command, version: "2.184.0" };
      },
    };
    const harness = oarHarness({
      require: (id) => {
        if (id !== "codebuddy") throw new Error("not offered here");
        return runtime;
      },
      list: () => [runtime],
    });
    const installed = async () => (await harness.catalog?.())?.find((h) => h.id === "codebuddy")?.installed;
    return { command, harness, installed, calls: () => calls };
  }

  it("keeps a harness whose probe missed it while its executable is still there", async () => {
    const { command, harness, installed } = flaky(["found", "missed", "timeout", "missed"]);
    expect(await installed()).toBe(true);
    expect(await installed()).toBe(true);
    expect(await installed()).toBe(true);
    // Sessions use the copy found last instead of failing on the missed probe.
    expect((await harness.available()).map((h) => h.id)).toEqual(["codebuddy"]);
    rmSync(command);
    expect(await installed()).toBe(false);
  });

  it("believes a harness that ran and refused", async () => {
    const { installed } = flaky(["found", "refused"]);
    expect(await installed()).toBe(true);
    expect(await installed()).toBe(false);
  });

  it("shares one probe between the list and the catalog asked together", async () => {
    const { harness, calls } = flaky(["found"]);
    const [list, catalog] = await Promise.all([harness.available(), harness.catalog?.()]);
    expect(calls()).toBe(1);
    expect(list.map((h) => h.id)).toEqual(["codebuddy"]);
    expect(catalog?.[0]?.installed).toBe(true);
    await harness.catalog?.();
    expect(calls()).toBe(2);
  });
});

describe("harness updates", () => {
  const codexWith = (overrides: Partial<Runtime>): Runtime => ({
    ...defaultRuntimes.require("codex"),
    installation: async () => ({ kind: "available", via: "executable", command: "codex", version: "0.1.0" }),
    ...overrides,
  });
  const harnessOf = (runtime: Runtime) => oarHarness({ require: () => runtime, list: () => [runtime] });

  it("reports a newer version only on the updater's own verdict", async () => {
    const check = vi.fn();
    const harness = harnessOf(codexWith({ checkUpdate: check }));
    check.mockResolvedValueOnce({
      kind: "ok",
      installed: "0.1.0",
      latest: "0.2.0",
      updateAvailable: true,
      source: "x",
    });
    expect(await harness.updateCheck?.("codex")).toEqual({ kind: "available", installed: "0.1.0", latest: "0.2.0" });
    check.mockResolvedValueOnce({
      kind: "ok",
      installed: "0.3.0",
      latest: "0.2.0",
      updateAvailable: false,
      source: "x",
    });
    expect(await harness.updateCheck?.("codex")).toEqual({ kind: "current", version: "0.3.0" });
    check.mockResolvedValueOnce({ kind: "unavailable", reason: "package_manager" });
    expect(await harness.updateCheck?.("codex")).toEqual({ kind: "unknown" });
    check.mockRejectedValueOnce(new Error("offline"));
    expect(await harness.updateCheck?.("codex")).toEqual({ kind: "unknown" });
    expect((await harness.catalog?.())?.[0]?.canUpdate).toBe(true);
  });

  it("judges an update by the version, not the updater's exit", async () => {
    const upgrade = vi.fn();
    const harness = harnessOf(codexWith({ upgrade }));
    upgrade.mockResolvedValueOnce({ kind: "upgraded", from: "0.1.0", to: "0.2.0", output: "" });
    expect(await harness.upgrade?.("codex")).toEqual({ ok: true });
    upgrade.mockResolvedValueOnce({ kind: "unchanged", version: "0.1.0", output: "done\n" });
    expect(await harness.upgrade?.("codex")).toEqual({ ok: false, detail: "done" });
    upgrade.mockResolvedValueOnce({ kind: "failed", exitCode: 1, output: "EACCES" });
    expect(await harness.upgrade?.("codex")).toEqual({ ok: false, detail: "EACCES" });
    upgrade.mockResolvedValueOnce({ kind: "unsupported", reason: "requires_terminal" });
    expect(await harness.upgrade?.("codex")).toEqual({ ok: false, detail: "requires_terminal" });
  });

  it("counts an update as done when the copy is already at the offered version", async () => {
    const check = vi.fn();
    const upgrade = vi.fn();
    const harness = harnessOf(codexWith({ checkUpdate: check, upgrade }));
    check.mockResolvedValueOnce({
      kind: "ok",
      installed: "0.1.0",
      latest: "0.2.0",
      updateAvailable: true,
      source: "x",
    });
    await harness.updateCheck?.("codex");
    // Updated meanwhile; the updater's own check could not reach its source, so it ran anyway.
    upgrade.mockResolvedValueOnce({ kind: "unchanged", version: "0.2.0", output: "Update ran successfully!\n" });
    expect(await harness.upgrade?.("codex")).toEqual({ ok: true });
    upgrade.mockResolvedValueOnce({ kind: "unchanged", version: "0.1.0", output: "Update ran successfully!\n" });
    expect(await harness.upgrade?.("codex")).toEqual({ ok: false, detail: "Update ran successfully!" });
  });

  it("offers no update for a harness without its own updater", async () => {
    const { checkUpdate: _check, upgrade: _upgrade, ...rest } = codexWith({});
    const harness = harnessOf(rest);
    expect(await harness.updateCheck?.("codex")).toEqual({ kind: "unknown" });
    expect((await harness.catalog?.())?.[0]?.canUpdate).toBe(false);
  });
});

describe("account usage", () => {
  const claudeWith = (overrides: Partial<Runtime>): Runtime => ({
    ...defaultRuntimes.require("claude"),
    installation: async () => ({ kind: "available", via: "executable", command: "claude", version: "2.1.0" }),
    ...overrides,
  });
  const harnessOf = (runtime: Runtime) => oarHarness({ require: () => runtime, list: () => [runtime] });
  const HOUR = 3_600_000;
  const WEEK = 7 * 24 * HOUR;

  it("keeps the fullest window of each length, shortest first", async () => {
    const accountUsage = vi.fn().mockResolvedValue({
      kind: "available",
      rateLimited: false,
      windows: [
        { label: "Current week (all models)", usedRatio: 0.3, durationMs: WEEK, resetsAt: "2026-11-20T09:00:00.000Z" },
        { label: "Current week (Opus)", usedRatio: 0.85, durationMs: WEEK },
        { label: "Current session", usedRatio: 1.2, durationMs: 5 * HOUR, resetsAt: "2026-11-16T15:00:00.000Z" },
        { label: "Extra usage", usedRatio: 0.1 },
      ],
    });
    const usage = await harnessOf(claudeWith({ accountUsage })).accountUsage?.("claude");
    expect(usage).toEqual({
      kind: "available",
      rateLimited: false,
      windows: [
        { label: "Current session", used: 1, durationMs: 5 * HOUR, resetsAt: Date.parse("2026-11-16T15:00:00.000Z") },
        { label: "Current week (Opus)", used: 0.85, durationMs: WEEK },
      ],
    });
    expect(accountUsage.mock.calls[0]?.[1]).toMatchObject({ limitResetDetails: false });
  });

  it("shows untimed windows only when there is nothing else", () => {
    expect(usageWindows([{ label: "Pay-as-you-go", used: 0.4 }])).toEqual([{ label: "Pay-as-you-go", used: 0.4 }]);
  });

  it("reports nothing it cannot show", async () => {
    const accountUsage = vi.fn();
    const harness = harnessOf(claudeWith({ accountUsage }));
    accountUsage.mockResolvedValueOnce({ kind: "reauth_required", reason: "not_authenticated" });
    expect(await harness.accountUsage?.("claude")).toEqual({ kind: "unknown" });
    accountUsage.mockResolvedValueOnce({ kind: "unsupported", reason: "unsupported_auth_mode" });
    expect(await harness.accountUsage?.("claude")).toEqual({ kind: "unknown" });
    accountUsage.mockRejectedValueOnce(new Error("offline"));
    expect(await harness.accountUsage?.("claude")).toEqual({ kind: "unknown" });
    const { accountUsage: _none, ...rest } = claudeWith({});
    expect(await harnessOf(rest).accountUsage?.("claude")).toEqual({ kind: "unknown" });
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

  it("never writes an agent's own variables into the prompt when the harness refuses an environment", async () => {
    const { runtime, opened, sent } = recording({ appendSystemPrompt: "fixture", env: "fixture refusal" });
    const harness = oarHarness({ require: () => runtime });
    expect((await harness.available()).find((h) => h.id === "codex")?.noEnv).toBe(true);
    expect(harness.acceptsEnv?.("codex")).toBe(false);
    const session = await harness.open(
      { harness: "codex", cwd: cwd(), appendSystemPrompt: PROMPT, env: { ...ENV, DAILY_WEBHOOK_URL: "s3cr3t-hook" } },
      events,
    );
    await session.deliver("hello", "i1");
    expect(opened[0]).not.toHaveProperty("env");
    expect(sent.join("\n")).not.toContain("s3cr3t-hook");
    expect(sent.join("\n")).not.toContain("DAILY_WEBHOOK_URL");
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
      next: "This harness cannot apply the settings Mingle needs (appendSystemPrompt: fixture refusal). Choose another harness.",
    });
  });

  it("opens a new session when the harness will not resume the saved one", async () => {
    // Pi with unregistered pending tools, DSH with a session saved elsewhere: the refusal is about
    // that conversation. Retrying the same resume would fail on every message forever.
    const sessionSpy = vi
      .fn()
      .mockRejectedValueOnce(new UnsupportedOptionError("resume", "fixture: cannot resume this one"))
      .mockResolvedValueOnce(fakeSession("s-new"));
    const runtime = { ...scriptedRuntime({ id: "flaky", turn: () => {} }), session: sessionSpy } as Runtime;
    const session = await open("flaky", runtime, "s-old");
    expect(session).toMatchObject({ id: "s-new", resumed: false });
    expect(sessionSpy.mock.calls[0]?.[1]).toMatchObject({ resume: "s-old", appendSystemPrompt: PROMPT });
    expect(sessionSpy.mock.calls[1]?.[1]).not.toHaveProperty("resume");
    expect(sessionSpy.mock.calls[1]?.[1]).toMatchObject({ appendSystemPrompt: PROMPT });
  });

  it("still reports incompatibility when a new session is refused too", async () => {
    const runtime = failing(new UnsupportedOptionError("model", "fixture refusal"));
    await expect(open("flaky", runtime, "s-old")).rejects.toMatchObject({ code: "harness_incompatible" });
    expect(runtime.session).toHaveBeenCalledTimes(2);
  });

  it("resumes Grok without an appended prompt, which it keeps from the saved session", async () => {
    // The real Grok runtime refuses appendSystemPrompt on every resume (OAR 0.97): after any
    // restart, every Grok agent stopped with harness_incompatible.
    const grok = defaultRuntimes.require("grok");
    const install = { kind: "available", via: "executable", command: "/nonexistent/grok", version: "1.0.52" } as const;
    await expect(
      grok.session(install, { cwd: cwd(), appendSystemPrompt: PROMPT, resume: "s-old" }),
    ).rejects.toMatchObject({ name: "UnsupportedOptionError", option: "appendSystemPrompt" });

    const delivered: string[] = [];
    const sessionSpy = vi.fn(async (_install: unknown, options: { appendSystemPrompt?: string; resume?: string }) => {
      if (options.resume && options.appendSystemPrompt !== undefined)
        throw new UnsupportedOptionError(
          "appendSystemPrompt",
          "Grok does not reapply appendSystemPrompt alone on resume",
        );
      return {
        ...fakeSession(options.resume ?? "s-new"),
        deliver: async (text: string) => {
          delivered.push(text);
          return { landed: "prompted" };
        },
      } as unknown as Session;
    });
    const runtime = { ...grok, installation: async () => install, session: sessionSpy } as unknown as Runtime;
    const session = await open("grok", runtime, "s-old");
    expect(session).toMatchObject({ id: "s-old", resumed: true });
    expect(sessionSpy).toHaveBeenCalledTimes(2);
    expect(sessionSpy.mock.calls[1]?.[1]).not.toHaveProperty("appendSystemPrompt");
    expect(sessionSpy.mock.calls[1]?.[1]).toMatchObject({ resume: "s-old", env: ENV });
    // The saved session has its guide: it is not repeated in the message.
    await session.deliver("hello", "i1");
    expect(delivered).toEqual(["hello"]);
  });

  it("keeps an ordinary failure as itself, not mislabeled unsupported", async () => {
    const error = new Error("fixture network failure");
    const runtime = failing(error);
    await expect(open("flaky", runtime)).rejects.toBe(error);
  });
});

describe("stopping work", () => {
  /** A session whose events the test emits, recording the controls it receives. */
  const driven = (options: { stopTask?: boolean; abortRejected?: boolean } = {}) => {
    let emit: (event: Record<string, unknown>) => void = () => {};
    const calls = { aborts: 0, stoppedTasks: [] as string[] };
    const session = {
      ...fakeSession(),
      events: (observer: (event: Record<string, unknown>) => void) => {
        emit = (event) => observer({ agentPath: [], ...event });
        return () => {};
      },
      abort: async () => {
        calls.aborts++;
        return options.abortRejected ? { kind: "rejected", code: "not_running", reason: "idle" } : { kind: "accepted" };
      },
      ...(options.stopTask === false
        ? {}
        : {
            stopTask: async (taskId: string) => {
              calls.stoppedTasks.push(taskId);
              return { kind: "accepted" };
            },
          }),
    } as unknown as Session;
    const runtime = {
      ...scriptedRuntime({ id: "claude", turn: () => {} }),
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: async () => session,
    } as unknown as Runtime;
    const seen: string[] = [];
    const opening = oarHarness({ require: () => runtime }).open(
      { harness: "claude", cwd: cwd(), appendSystemPrompt: PROMPT, env: ENV },
      {
        onTurnStarted: (self) => seen.push(self ? "self" : "prompted"),
        onTurnEnded: (outcome) => seen.push(`ended:${outcome.kind}`),
        onActivity: () => {},
      },
    );
    return { opening, emit: (event: Record<string, unknown>) => emit(event), calls, seen };
  };

  it("reports a turn the harness begins on its own, once", async () => {
    const { opening, emit, seen } = driven();
    await opening;
    emit({ kind: "turn_started" });
    emit({ kind: "tool_call_started", tool: "Bash" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    // A background command ended: the harness wakes the agent without a prompt.
    emit({ kind: "text_delta" });
    emit({ kind: "tool_call_started", tool: "Bash" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect(seen).toEqual(["prompted", "ended:completed", "self", "ended:completed"]);
  });

  it("stops the background tasks a turn left running, and only those still running", async () => {
    const { opening, emit, calls } = driven();
    const session = await opening;
    emit({ kind: "turn_started" });
    emit({ kind: "task_started", taskId: "t1", taskType: "shell", background: true });
    emit({ kind: "task_started", taskId: "t2", taskType: "shell", background: true });
    emit({ kind: "task_started", taskId: "t3", taskType: "other", ambient: true });
    emit({ kind: "task_ended", taskId: "t2", status: "completed" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    // Idle, but a background command is still running: there is something to stop.
    expect(await session.abort()).toBe(true);
    expect(calls.aborts).toBe(0);
    expect(calls.stoppedTasks).toEqual(["t1"]);
    emit({ kind: "task_ended", taskId: "t1", status: "stopped" });
    expect(await session.abort()).toBe(false);
  });

  it("closes a turn it began itself when the harness no longer has it", async () => {
    const { opening, emit, seen } = driven({ abortRejected: true, stopTask: false });
    const session = await opening;
    emit({ kind: "tool_call_started", tool: "Bash" });
    expect(await session.abort()).toBe(true);
    expect(seen).toEqual(["self", "ended:aborted"]);
  });

  it("opens a self-initiated turn immediately on turn_active before the model emits tokens", async () => {
    const { opening, emit, seen } = driven();
    await opening;
    emit({ kind: "turn_started" });
    // Normal prompted turn: turn_active must not fire a second onTurnStarted.
    emit({ kind: "turn_active", inputId: "in-1" });
    emit({ kind: "text_delta" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    // Background task finishes and the harness starts a turn on its own (system/init → turn_active).
    emit({ kind: "turn_active" });
    expect(seen).toEqual(["prompted", "ended:completed", "self"]);
    // First model token arrives later (slow TTFT): still the same turn, no duplicate start.
    emit({ kind: "reasoning" });
    emit({ kind: "text_delta" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    // A queued input whose turn starts natively (turn_active with inputId) is prompted, not self.
    emit({ kind: "turn_active", inputId: "in-2" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect(seen).toEqual(["prompted", "ended:completed", "self", "ended:completed", "prompted", "ended:completed"]);
  });

  it("keeps empty-turn detection accurate when a prompted turn emits turn_active without model output", async () => {
    let emit: (event: Record<string, unknown>) => void = () => {};
    const session = {
      ...fakeSession(),
      events: (observer: (event: Record<string, unknown>) => void) => {
        emit = (event) => observer({ agentPath: [], ...event });
        return () => {};
      },
    } as unknown as Session;
    const runtime = {
      ...scriptedRuntime({ id: "claude", turn: () => {} }),
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: async () => session,
    } as unknown as Runtime;
    const ended: unknown[] = [];
    await oarHarness({ require: () => runtime }).open(
      { harness: "claude", cwd: cwd(), appendSystemPrompt: PROMPT, env: ENV },
      {
        onTurnStarted: () => {},
        onTurnEnded: (outcome) => ended.push(outcome),
        onActivity: () => {},
      },
    );
    emit({ kind: "turn_started" });
    emit({ kind: "turn_active", inputId: "in-1" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    expect(ended).toEqual([{ kind: "completed", empty: true }]);
  });

  it("ends an open turn or background wait with runtime_exited on unexpected exit, but not on dispose", async () => {
    let emit: (event: Record<string, unknown>) => void = () => {};
    const session = {
      ...fakeSession(),
      events: (observer: (event: Record<string, unknown>) => void) => {
        emit = (event) => observer({ agentPath: [], ...event });
        return () => {};
      },
      dispose: async () => {
        emit({ kind: "exited", code: 0 });
      },
    } as unknown as Session;
    const runtime = {
      ...scriptedRuntime({ id: "claude", turn: () => {} }),
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: async () => session,
    } as unknown as Runtime;
    const ended: unknown[] = [];
    const opened = await oarHarness({ require: () => runtime }).open(
      { harness: "claude", cwd: cwd(), appendSystemPrompt: PROMPT, env: ENV },
      {
        onTurnStarted: () => {},
        onTurnEnded: (outcome) => ended.push(outcome),
        onActivity: () => {},
      },
    );
    // Crash mid-turn: immediately reports runtime_exited and clears background tasks.
    emit({ kind: "turn_started" });
    emit({ kind: "task_started", taskId: "t1", taskType: "shell", background: true });
    emit({ kind: "exited", code: 137 });
    expect(opened.background?.()).toBe(0);
    expect(ended).toEqual([{ kind: "failed", failure: "runtime_exited", reason: "the harness exited (code 137)" }]);

    // Crash while waiting on background work after a turn ended: also reports runtime_exited.
    emit({ kind: "task_started", taskId: "t2", taskType: "shell", background: true });
    emit({ kind: "exited", code: null, reason: "killed" });
    expect(opened.background?.()).toBe(0);
    expect(ended).toHaveLength(2);
    expect(ended[1]).toEqual({ kind: "failed", failure: "runtime_exited", reason: "killed" });

    // Normal dispose emits exited: must not report a failure.
    emit({ kind: "turn_started" });
    await opened.dispose();
    expect(ended).toHaveLength(2);
  });
});

describe("turn usage", () => {
  it.each(["before end", "after end", "earlier frame"] as const)(
    "reports the complete turn once when usage is %s",
    async (order) => {
      const kernel = createSessionKernel("usage-fixture");
      const frame = (...events: RuntimeEventBody[]) => kernel.frame({ type: "fixture", native: {}, events });
      const usage = (input: number, output: number, cacheRead: number, cacheWrite: number): RuntimeEventBody => ({
        kind: "usage",
        usage: { total: { input, output, cacheRead, cacheWrite } },
      });
      const end: RuntimeEventBody = { kind: "turn_ended", outcome: { kind: "completed" } };
      const fixture = {
        ...fakeSession(kernel.sessionId),
        events: (observer: EventObserver) =>
          kernel.rawEvents((record) => {
            for (const event of eventsOf(record)) observer(event);
          }),
        usage: () => usageOf(kernel.records(), kernel.sessionId),
      } as unknown as Session;
      const native = {
        ...scriptedRuntime({ turn: () => {} }),
        session: async () => fixture,
      };
      const onTurnUsage = vi.fn();
      const callbacks: string[] = [];
      const session = await oarHarness({ require: () => native }).open(
        { harness: "scripted", cwd: cwd(), appendSystemPrompt: PROMPT, env: ENV },
        {
          ...events,
          onTurnUsage: (value) => {
            onTurnUsage(value);
            callbacks.push("usage");
          },
          onTurnEnded: () => {
            callbacks.push("ended");
          },
        },
      );
      try {
        frame(usage(1000, 100, 100, 200));
        kernel.request("toRuntime", { kind: "prompt", input: "first" });
        frame(usage(1100, 110, 130, 240));
        const final = usage(1300, 130, 190, 320);
        if (order === "earlier frame") {
          frame(final);
          frame(end);
        } else frame(...(order === "before end" ? [final, end] : [end, final]));
        expect(onTurnUsage.mock.calls).toEqual([[{ input: 300, output: 30, cacheRead: 90, cacheWrite: 120 }]]);
        expect(callbacks).toEqual(["usage", "ended"]);
        // Repeating a usage report outside a turn must not report the turn twice.
        frame(final);
        expect(onTurnUsage).toHaveBeenCalledTimes(1);
        // A background wake must start its own baseline, not reuse the previous prompted turn.
        frame({ kind: "text_delta", text: "background completion" });
        frame(end, usage(1500, 150, 240, 400));
        expect(onTurnUsage.mock.calls[1]).toEqual([{ input: 200, output: 20, cacheRead: 50, cacheWrite: 80 }]);
        // Nor may that turn's spend bleed into the next prompted turn.
        kernel.request("toRuntime", { kind: "prompt", input: "next" });
        frame(usage(1550, 155, 250, 420), end);
        expect(onTurnUsage.mock.calls[2]).toEqual([{ input: 50, output: 5, cacheRead: 10, cacheWrite: 20 }]);
        expect(onTurnUsage).toHaveBeenCalledTimes(3);
      } finally {
        await session.dispose();
      }
    },
  );
});

it("runs Devin ACP's full terminal command with the session environment", async () => {
  const dir = cwd();
  copyFileSync(new URL("./fixtures/devin-acp.cjs", import.meta.url), join(dir, "acp"));
  const session = await defaultRuntimes
    .require("devin")
    .session({ kind: "available", via: "executable", command: process.execPath }, { cwd: dir, env: ENV });
  try {
    const result = await promptAndWait(session, "check the terminal", { timeoutMs: 3000 });
    expect(result).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(result.kind === "ended" && result.text.trim()).toBe("present");
  } finally {
    await session.dispose();
  }
});
