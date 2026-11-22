/**
 * The only module that imports OAR. Everything else depends on these types,
 * so an OAR upgrade touches this file alone.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AvailableInstallation,
  type CursorSdk,
  createCursorRuntime,
  defaultRuntimes,
  type ExecutableInstallation,
  type InstallationSnapshot,
  type Runtime,
  RuntimeFailureError,
  runtimeBrandIcon,
  type Session,
  UnsupportedOptionError,
  userShellEnvironment,
} from "@botiverse/oar";
import { MingleError } from "../core/errors.ts";

export interface HarnessInfo {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  /** SVG data URLs of the harness's mark, from OAR's offline brand set. */
  readonly icon?: { readonly light: string; readonly dark: string };
  /** Listed but cannot serve Mingle: what is missing and the next step. */
  readonly disabled?: { readonly code: string; readonly reason: string };
  /** Its shell does not get the session's environment, so an agent's own variables do not reach it. */
  readonly noEnv?: true;
}

/** A model the harness will run right now. */
export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  /** The model the harness uses when none is chosen, where it says so. */
  readonly isDefault?: boolean;
  readonly provider?: string;
  /** Listed, but the harness refuses it as it is (often: the CLI needs an upgrade). */
  readonly disabled?: string;
}

export type ModelList =
  | { readonly kind: "ok"; readonly models: readonly ModelInfo[] }
  | { readonly kind: "unauthenticated" }
  | { readonly kind: "unsupported" };

export interface OpenOptions {
  readonly harness: string;
  readonly model?: string | null;
  readonly cwd: string;
  /** Previous session id. When the harness no longer has it, a fresh session opens instead. */
  readonly resume?: string | null;
  readonly appendSystemPrompt: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * Why a turn (or opening a session) failed, in classes a person can act on. OAR's
 * failure classes, plus `not_installed` when the harness is missing altogether.
 */
export type Failure =
  | "auth"
  | "quota"
  | "rate_limited"
  | "billing"
  | "model_unavailable"
  | "input_too_large"
  | "invalid_request"
  | "overloaded"
  | "provider"
  | "runtime_exited"
  | "limit_reached"
  | "output_schema"
  | "not_installed"
  | "unknown";

/** A failure to open a session or deliver to it, with its class. */
export class HarnessError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure, message: string) {
    super(message);
    this.name = "HarnessError";
    this.failure = failure;
  }
}

/** The class of any error thrown by the harness layer; `unknown` when it does not say. */
export function failureOf(error: unknown): Failure {
  if (error instanceof HarnessError) return error.failure;
  if (error instanceof RuntimeFailureError) return error.failure;
  return "unknown";
}

export interface TurnEnd {
  readonly kind: string;
  readonly reason?: string;
  /** Set when `kind` is `failed`. */
  readonly failure?: Failure;
  /** For `quota`: when the limit resets (epoch ms), where the harness reports it. */
  readonly resetsAt?: number;
  /**
   * A prompted turn that completed with no reasoning, text or tool call: the harness acknowledged
   * the input without running the model on it. Kimi Code does this while a turn it began itself
   * (a background task finishing) is running: the prompt is queued natively and answered at once,
   * and the model only sees it when that turn ends (earayu/Mingle#125).
   */
  readonly empty?: boolean;
}

export interface HarnessEvents {
  /**
   * A turn began. `self`: the harness began it on its own, not for input Mingle delivered;
   * Claude Code does this when a background command it started earlier finishes.
   */
  onTurnStarted(self?: boolean): void;
  onTurnEnded(outcome: TurnEnd): void;
  /** Something visible happened inside a turn: reasoning, text, or a tool call. */
  onActivity(kind: "thinking" | "tool", detail?: string): void;
  /** The root agent finished a tool call: its name and, where the harness reports it, its input. */
  onAction?(tool: string, input?: string): void;
  /** What the turn that just ended cost, once the harness reports it. */
  onTurnUsage?(usage: TurnUsage): void;
  /**
   * The harness reported anything at all: the session is alive, whatever the event. Subagent
   * work and background tasks count too, though they show no activity of their own.
   */
  onProgress?(): void;
}

/** Tokens one turn used, every model call in it together. */
export interface TurnUsage {
  /** All input, cache reads and writes included. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type DeliverOutcome = "prompted" | "steered" | "queued" | "rejected";

export interface HarnessSession {
  readonly id: string;
  /** True when this open resumed `resume`; false when a fresh session replaced it. */
  readonly resumed: boolean;
  deliver(text: string, inputId: string): Promise<{ outcome: DeliverOutcome; reason?: string }>;
  /** Tokens in the session's context as the harness last reported it; null before it has. */
  contextTokens?(): number | null;
  /**
   * Background tasks (commands, subagents) the session started and still runs. Claude Code begins a
   * turn of its own when one ends, so the session must stay open until then.
   */
  background?(): number;
  /**
   * Stop the agent's work: the running turn, and the background tasks (commands, subagents) it
   * left running, where the harness can stop one task (Claude Code, Codex, Qoder). True when
   * there was something to stop.
   */
  abort(): Promise<boolean>;
  dispose(): Promise<void>;
}

/** Every harness OAR knows, installed or not, and what Mingle can do about the ones that are not. */
export interface HarnessStatus extends HarnessInfo {
  readonly installed: boolean;
  /** Not installable here, in the runtime's own words (another platform, say). */
  readonly unsupported?: string;
  /** The runtime can install itself (`install`). */
  readonly canInstall: boolean;
  /** The runtime has its own sign-in (`login`). */
  readonly canSignIn: boolean;
  /** The runtime can tell whether a newer version exists and update itself (`checkUpdate`, `upgrade`). */
  readonly canUpdate: boolean;
}

/** What the installed harness's own updater would do. `unknown` never means it is current. */
export type UpdateInfo =
  | { readonly kind: "available"; readonly installed: string; readonly latest: string }
  | { readonly kind: "current"; readonly version: string }
  | { readonly kind: "unknown" };

export type SignInState =
  | { readonly kind: "signed_in"; readonly account?: string; readonly plan?: string }
  | { readonly kind: "signed_out"; readonly detail?: string }
  | { readonly kind: "unknown" };

/** One usage limit of the signed-in account: how much of it is gone and when it starts over. */
export interface UsageWindow {
  /** The harness's own name for it, in English; the console names it by `durationMs` where it can. */
  readonly label: string;
  /** Consumed fraction, 0 to 1. */
  readonly used: number;
  /** Epoch ms of the next reset, where the harness reports it. */
  readonly resetsAt?: number;
  readonly durationMs?: number;
}

/**
 * The account's quota as the harness reports it, for this computer's own sign-in. `unknown`
 * covers a harness that cannot tell, a signed-out account (the sign-in state says so) and a
 * read that failed: none of them is something to show.
 */
export type AccountUsage =
  | { readonly kind: "available"; readonly rateLimited: boolean; readonly windows: readonly UsageWindow[] }
  | { readonly kind: "unknown" };

/**
 * The windows worth a line: per length the one closest to its limit (Claude reports a week for
 * all models, one for Opus, one for OAuth apps, and the fullest is the one that stops a turn),
 * shortest first. Windows without a length (extra usage, pay as you go) only when there is
 * nothing else. At most three.
 */
export function usageWindows(windows: readonly UsageWindow[]): UsageWindow[] {
  const timed = new Map<number, UsageWindow>();
  for (const w of windows) {
    if (w.durationMs === undefined) continue;
    const held = timed.get(w.durationMs);
    if (!held || w.used > held.used) timed.set(w.durationMs, w);
  }
  const picked = timed.size
    ? [...timed.values()].sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0))
    : [...windows];
  return picked.slice(0, 3);
}

export type InstallPlanInfo =
  | { readonly kind: "plan"; readonly steps: readonly string[]; readonly source: string }
  | {
      readonly kind: "unsupported";
      readonly detail: string;
      readonly steps?: readonly string[];
      readonly source?: string;
    };

/** What a sign-in shows the person, and asks of them. */
export interface SignInInteraction {
  readonly signal: AbortSignal;
  onEvent(
    event:
      | { readonly kind: "url"; readonly url: string; readonly instructions?: string }
      | { readonly kind: "code"; readonly code: string; readonly url: string }
      | { readonly kind: "info"; readonly message: string },
  ): void;
  /** The runtime needs something typed back (a pasted code, an API key). */
  prompt(question: {
    readonly message: string;
    readonly secret: boolean;
    /** A choice instead of free text; the answer is one option's id. */
    readonly options?: readonly { readonly id: string; readonly label: string }[];
  }): Promise<string>;
}

export interface Harness {
  available(): Promise<HarnessInfo[]>;
  /** Every harness, installed or not. */
  catalog?(): Promise<HarnessStatus[]>;
  signInState?(id: string): Promise<SignInState>;
  installPlan?(id: string): Promise<InstallPlanInfo>;
  install?(id: string): Promise<{ ok: boolean; detail?: string }>;
  /** Read only: asks the harness's update source, never installs. */
  updateCheck?(id: string): Promise<UpdateInfo>;
  /** The signed-in account's quota. Asks the harness or its vendor, so it can take seconds. */
  accountUsage?(id: string): Promise<AccountUsage>;
  /** Runs the harness's own updater, judged by the version it reports afterwards. */
  upgrade?(id: string): Promise<{ ok: boolean; detail?: string }>;
  signIn?(id: string, interaction: SignInInteraction): Promise<{ ok: boolean; detail?: string }>;
  /** The harness's display name ("Claude Code"), for messages to people. */
  name?(id: string): string;
  /** Whether the harness's shell gets `OpenOptions.env`. Unknown harnesses count as yes. */
  acceptsEnv?(id: string): boolean;
  /** What can go in `OpenOptions.model`. Asks the harness, so it can take seconds. */
  models?(id: string): Promise<ModelList>;
  open(options: OpenOptions, events: HarnessEvents): Promise<HarnessSession>;
}

/** Display order: the best known first. Any other runtime OAR ships comes after these. */
const ORDER = [
  "claude",
  "codex",
  "cursor",
  "opencode",
  "kimi",
  "grok",
  "qwen",
  "qoder",
  "codebuddy",
  "dsh",
  "pi",
  "antigravity",
  "devin",
  "factory",
];

export interface RuntimeSource {
  require(id: string): Runtime;
  list?(): readonly Runtime[];
}

/**
 * Whether an installed harness can serve Mingle. OAR's declarations do not cover
 * OpenCode's version difference (1.x supports appended prompts, 2.x fails on them
 * at open), so OpenCode gets a version check here.
 */
function incompatibility(runtime: Runtime, install: AvailableInstallation): HarnessInfo["disabled"] {
  // A refused appended prompt or environment is no longer a blocker: `open` then carries the
  // guide, and the CLI's settings, in the session's first message.
  if (runtime.id === "opencode") {
    const version = install.via === "executable" ? install.version?.trim() : undefined;
    // OAR 0.97 supports prompt injection on OpenCode 1.x only. Its public
    // refusal map omits this version-specific restriction.
    if (!version || !/^(?:opencode\s+)?v?1\.\d+\.\d+(?:\S*)$/u.test(version)) {
      return {
        code: "harness_opencode_version",
        reason: "This OpenCode version is not compatible with Mingle. Use OpenCode 1.x or choose another harness.",
      };
    }
  }
  return undefined;
}

/**
 * Resume `id`, or open a fresh session when the saved one cannot come back. A refusal at resume
 * is about that saved session, not about the harness: a harness that refuses to resume one
 * conversation (Pi with unregistered pending tools, DSH with a session saved elsewhere) still
 * opens new ones, and retrying the same resume would fail on every message forever. Grok refuses
 * an appended prompt on every resume, keeping the one saved with the session: resume without it.
 */
async function resumeOrReplace(
  runtime: Runtime,
  install: AvailableInstallation,
  base: Parameters<Runtime["session"]>[1],
  id: string,
): Promise<{ session: Session; resumed: boolean; keptGuide: boolean }> {
  try {
    return { session: await runtime.session(install, { ...base, resume: id }), resumed: true, keptGuide: false };
  } catch (error) {
    if (error instanceof UnsupportedOptionError && error.option === "appendSystemPrompt" && base.appendSystemPrompt) {
      const { appendSystemPrompt: _, ...rest } = base;
      try {
        return { session: await runtime.session(install, { ...rest, resume: id }), resumed: true, keptGuide: true };
      } catch (retry) {
        if (!replaceable(retry)) throw retry;
      }
    } else if (!replaceable(error)) throw error;
  }
  return { session: await runtime.session(install, base), resumed: false, keptGuide: false };
}

/** The saved session is gone, or the harness will not resume it as asked: a new one takes its place. */
function replaceable(error: unknown): boolean {
  return error instanceof UnsupportedOptionError || (error as Error).name === "SessionNotFoundError";
}

function requireCompatible(runtime: Runtime, install: AvailableInstallation): void {
  const issue = incompatibility(runtime, install);
  if (issue) throw new MingleError(issue.code, issue.reason);
}

const CURSOR_SDK = "@cursor/sdk";
const CURSOR_SDK_VERSION = "1.3.1";

/**
 * Cursor runs in process through its SDK, which is Cursor's own package under Cursor's terms:
 * Mingle does not ship it. On the person's request Mingle installs it with npm into its own
 * data folder, and loads it from there.
 */
export function cursorRuntime(vendorDir: string): Runtime {
  const packageDir = join(vendorDir, "node_modules", ...CURSOR_SDK.split("/"));
  const installed = () => existsSync(join(packageDir, "package.json"));
  const version = () => {
    try {
      return (JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version?: string }).version;
    } catch {
      return undefined;
    }
  };
  const base = createCursorRuntime({
    sdk: async () => {
      // The package's ESM entry: an import of its CommonJS `main` would hide the named exports.
      const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
        main?: string;
        module?: string;
        exports?: { ".": { import?: string; default?: string } };
      };
      const entry = pkg.exports?.["."]?.import ?? pkg.exports?.["."]?.default ?? pkg.module ?? pkg.main ?? "index.js";
      return (await import(pathToFileURL(join(packageDir, entry)).href)) as CursorSdk;
    },
  });
  const steps = [
    "npm",
    "install",
    "--no-audit",
    "--no-fund",
    "--prefix",
    vendorDir,
    `${CURSOR_SDK}@${CURSOR_SDK_VERSION}`,
  ];
  const plan = {
    kind: "plan" as const,
    steps: [{ command: steps, display: steps.join(" ") }],
    source: "https://www.npmjs.com/package/@cursor/sdk",
    network: true as const,
    privileges: false as const,
  };
  return {
    ...base,
    vendorVersion: version,
    installation: async (options) => {
      if (!installed()) return { kind: "not_found" };
      // Cursor's own calls expect the SDK installation it reports itself.
      return base.installation(options);
    },
    installPlan: async () => plan,
    install: async (options) => {
      if (installed()) return { kind: "already_installed", installation: { kind: "available", via: "bundled" } };
      const output = await new Promise<{ code: number | null; text: string }>((resolve) => {
        const child = spawn(steps[0] as string, steps.slice(1), {
          stdio: ["ignore", "pipe", "pipe"],
          shell: process.platform === "win32",
        });
        let text = "";
        child.stdout.on("data", (d) => (text += d));
        child.stderr.on("data", (d) => (text += d));
        const timer = setTimeout(() => child.kill(), options?.timeoutMs ?? 10 * 60_000);
        child.on("error", (e) => resolve({ code: null, text: `${text}${(e as Error).message}` }));
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, text });
        });
      });
      return installed()
        ? { kind: "installed", installation: { kind: "available", via: "bundled" }, output: output.text }
        : { kind: "failed", exitCode: output.code, output: output.text };
    },
  } as Runtime;
}

const refusesEnv = (runtime: Runtime) => "env" in (runtime.refusedSessionOptions ?? {});

/** For a harness whose shell does not get Mingle's environment: the same values, written into the command. */
function inlineEnvNote(env: Readonly<Record<string, string>>): string {
  const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
  const prefix = Object.entries(env)
    .filter(([k]) => k.startsWith("MINGLE_"))
    .map(([k, v]) => `${k}=${quote(v)}`)
    .join(" ");
  return [
    "## Calling the CLI from your shell",
    "",
    'Your shell does not have the MINGLE_ variables set. Wherever this guide writes `"$MINGLE_CLI"`, write this instead, all on the command\'s own line:',
    "",
    "```",
    `${prefix} ${quote(env.MINGLE_CLI ?? "mingle")}`,
    "```",
  ].join("\n");
}

export function oarHarness(source: RuntimeSource = defaultRuntimes, options: { vendorDir?: string } = {}): Harness {
  /**
   * Where each harness was last found. A probe can miss a harness that is there: its readiness
   * check (`codebuddy --help`) or the npm lookup behind it runs out of time while every harness
   * starts at once, which on Windows (a .cmd shim, Node, an antivirus scan) can take seconds. One
   * miss would flip the harness between installed and not from one look to the next. So a probe
   * that finds nothing, or does not answer, keeps the last copy while its executable is still on
   * disk. A harness that ran and refused (`unsupported`), or whose file is gone, is believed.
   */
  const lastFound = new Map<string, ExecutableInstallation>();

  async function probe(runtime: Runtime): Promise<InstallationSnapshot | undefined> {
    let found: InstallationSnapshot | undefined;
    let failure: unknown;
    try {
      found = await runtime.installation?.();
    } catch (error) {
      failure = error;
    }
    if (found?.kind === "available") {
      if (found.via === "executable") lastFound.set(runtime.id, found);
      else lastFound.delete(runtime.id);
      return found;
    }
    const last = lastFound.get(runtime.id);
    if (found?.kind !== "unsupported" && last && existsSync(last.command)) return last;
    lastFound.delete(runtime.id);
    if (failure !== undefined) throw failure;
    return found;
  }

  async function installation(runtime: Runtime): Promise<AvailableInstallation> {
    const found = await probe(runtime);
    if (found?.kind !== "available") {
      throw new HarnessError("not_installed", `${runtime.id} is not installed on this computer`);
    }
    return found;
  }

  const cursor = options.vendorDir ? cursorRuntime(options.vendorDir) : undefined;
  const lookup = (id: string): Runtime => (id === "cursor" && cursor ? cursor : source.require(id));
  const ids = () => {
    const known = new Set([...(source.list?.() ?? []).map((r) => r.id), ...(cursor ? ["cursor"] : [])]);
    return [
      ...ORDER.filter((id) => known.has(id) || (id !== "cursor" && safeRequire(id))),
      ...[...known].filter((id) => !ORDER.includes(id)),
    ];
  };
  const safeRequire = (id: string) => {
    try {
      return source.require(id);
    } catch {
      return undefined;
    }
  };
  const info = (id: string, runtime: Runtime, found?: AvailableInstallation): HarnessInfo => {
    // Harnesses print versions their own way ("2.1.322 (Claude Code)", "codex-cli 0.167.1"): keep the number.
    const reported =
      found?.via === "executable"
        ? found.version
        : (runtime as { vendorVersion?: () => string | undefined }).vendorVersion?.();
    const version = /\d+(?:\.\d+)+/.exec(reported ?? "")?.[0];
    const brand = runtime.brand;
    const light = brand ? runtimeBrandIcon(brand, "light") : null;
    const dark = brand ? runtimeBrandIcon(brand, "dark") : null;
    return {
      id,
      name: brand?.name ?? id,
      ...(version ? { version } : {}),
      ...(light && dark ? { icon: { light, dark } } : {}),
      ...(refusesEnv(runtime) ? { noEnv: true as const } : {}),
    };
  };

  /** The newest version each harness's updater last named: what an update offered goes to. */
  const latest = new Map<string, string>();

  /** Every harness's state. Each probe starts the harness's executable; run them side by side. */
  const look = (): Promise<HarnessStatus[]> =>
    Promise.all(
      ids().map(async (id): Promise<HarnessStatus> => {
        const runtime = lookup(id);
        const found = await probe(runtime).catch(() => undefined);
        const available = found?.kind === "available" ? found : undefined;
        const disabled = available ? incompatibility(runtime, available) : undefined;
        return {
          ...info(id, runtime, available),
          ...(disabled ? { disabled } : {}),
          installed: Boolean(available),
          ...(found?.kind === "unsupported" ? { unsupported: found.reason } : {}),
          canInstall: Boolean(runtime.install),
          canSignIn: Boolean(runtime.login),
          canUpdate: Boolean(runtime.checkUpdate && runtime.upgrade),
        };
      }),
    );
  let looking: Promise<HarnessStatus[]> | undefined;

  return {
    async available() {
      return (await this.catalog?.())?.filter((h) => h.installed) ?? [];
    },

    catalog() {
      // `available` and `catalog` are often asked together; share one look instead of starting
      // every harness twice at once, which is what makes a slow one miss its deadline.
      if (looking) return looking;
      const current: Promise<HarnessStatus[]> = look().finally(() => {
        if (looking === current) looking = undefined;
      });
      looking = current;
      return current;
    },

    async signInState(id) {
      const runtime = lookup(id);
      if (!runtime.authStatus) return { kind: "unknown" };
      const status = await runtime
        .authStatus(await installation(runtime), { timeoutMs: 15_000 })
        .catch(() => undefined);
      if (status?.kind === "logged_in") {
        const who = status.account?.email ?? status.account?.method;
        return {
          kind: "signed_in",
          ...(who ? { account: who } : {}),
          ...(status.account?.plan ? { plan: status.account.plan } : {}),
        };
      }
      if (status?.kind === "logged_out")
        return { kind: "signed_out", ...(status.detail ? { detail: status.detail } : {}) };
      return { kind: "unknown" };
    },

    async accountUsage(id) {
      const runtime = lookup(id);
      if (!runtime.accountUsage) return { kind: "unknown" };
      const usage = await runtime
        .accountUsage(await installation(runtime), { timeoutMs: 15_000, limitResetDetails: false })
        .catch(() => undefined);
      if (usage?.kind !== "available") return { kind: "unknown" };
      const windows = usage.windows.flatMap((w): UsageWindow[] => {
        if (!Number.isFinite(w.usedRatio)) return [];
        const resetsAt = w.resetsAt ? Date.parse(w.resetsAt) : Number.NaN;
        return [
          {
            label: w.label,
            used: Math.min(1, Math.max(0, w.usedRatio)),
            ...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
            ...(w.durationMs ? { durationMs: w.durationMs } : {}),
          },
        ];
      });
      return { kind: "available", rateLimited: usage.rateLimited, windows: usageWindows(windows) };
    },

    async installPlan(id) {
      const runtime = lookup(id);
      if (!runtime.installPlan) return { kind: "unsupported", detail: "no installer" };
      const plan = await runtime.installPlan(
        runtime.installLines?.length ? { line: runtime.installLines[0]?.line as string } : {},
      );
      if (plan.kind === "plan") return { kind: "plan", steps: plan.steps.map((s) => s.display), source: plan.source };
      return {
        kind: "unsupported",
        detail: plan.detail ?? plan.reason,
        ...(plan.steps ? { steps: plan.steps.map((s) => s.display) } : {}),
        ...(plan.source ? { source: plan.source } : {}),
      };
    },

    async install(id) {
      const runtime = lookup(id);
      if (!runtime.install) return { ok: false, detail: "no installer" };
      const result = await runtime.install({
        timeoutMs: 10 * 60_000,
        ...(runtime.installLines?.length ? { line: runtime.installLines[0]?.line as string } : {}),
      });
      // A look started before the install must not answer for after it.
      looking = undefined;
      if (result.kind === "installed" || result.kind === "already_installed") return { ok: true };
      if (result.kind === "failed") return { ok: false, detail: result.output.trim().split("\n").slice(-6).join("\n") };
      return { ok: false, detail: result.detail ?? result.reason };
    },

    async updateCheck(id) {
      const runtime = lookup(id);
      if (!runtime.checkUpdate || !runtime.upgrade) return { kind: "unknown" };
      const check = await runtime
        .checkUpdate(await installation(runtime), { timeoutMs: 15_000 })
        .catch(() => undefined);
      if (check?.kind !== "ok") return { kind: "unknown" };
      latest.set(id, check.latest);
      return check.updateAvailable
        ? { kind: "available", installed: check.installed, latest: check.latest }
        : { kind: "current", version: check.installed };
    },

    async upgrade(id) {
      const runtime = lookup(id);
      if (!runtime.upgrade) return { ok: false, detail: "no updater" };
      const result = await runtime.upgrade(await installation(runtime), { timeoutMs: 10 * 60_000 });
      looking = undefined;
      const tail = (output: string) => output.trim().split("\n").slice(-6).join("\n");
      if (result.kind === "upgraded" || result.kind === "current") return { ok: true };
      // Updaters can exit 0 without touching this copy; the version it reports decides. A copy
      // already at the version the update was offered for (updated meanwhile, while the check
      // that precedes the updater could not reach its source) is up to date, not a failure.
      if (result.kind === "unchanged" && result.version === latest.get(id)) return { ok: true };
      if (result.kind === "unchanged") return { ok: false, detail: tail(result.output) || `still ${result.version}` };
      if (result.kind === "failed") return { ok: false, detail: tail(result.output) };
      return { ok: false, detail: result.detail ?? result.reason };
    },

    async signIn(id, interaction) {
      const runtime = lookup(id);
      if (!runtime.login) return { ok: false, detail: "no sign-in" };
      const result = await runtime.login(
        await installation(runtime),
        {
          signal: interaction.signal,
          onEvent: (event) => {
            if (event.kind === "auth_url")
              interaction.onEvent({
                kind: "url",
                url: event.url,
                ...(event.instructions ? { instructions: event.instructions } : {}),
              });
            else if (event.kind === "device_code")
              interaction.onEvent({ kind: "code", code: event.userCode, url: event.verificationUri });
            else interaction.onEvent({ kind: "info", message: event.message });
          },
          prompt: async (question) => {
            if (question.kind === "select")
              return interaction.prompt({
                message: question.message,
                secret: false,
                options: question.options.map((o) => ({ id: o.id, label: o.label })),
              });
            return interaction.prompt({ message: question.message, secret: question.kind !== "text" });
          },
        },
        // The console shows the link itself: the person opens it there, on this computer or another.
        { openBrowser: false, timeoutMs: 10 * 60_000 },
      );
      if (result.kind === "logged_in") return { ok: true };
      if (result.kind === "cancelled") return { ok: false, detail: "cancelled" };
      return { ok: false, detail: result.detail ?? result.reason };
    },

    acceptsEnv(id) {
      try {
        return !refusesEnv(lookup(id));
      } catch {
        return true;
      }
    },

    name(id) {
      try {
        return lookup(id).brand?.name ?? id;
      } catch {
        return id;
      }
    },

    async models(id) {
      const runtime = lookup(id);
      const install = await installation(runtime);
      requireCompatible(runtime, install);
      if (!runtime.listModels) return { kind: "unsupported" };
      const result = await runtime.listModels(install, { timeoutMs: 20_000 });
      if (result.kind !== "ok") return { kind: result.kind };
      return {
        kind: "ok",
        models: result.models.map((m) => ({
          id: m.id,
          name: m.displayName ?? m.id,
          ...(m.default ? { isDefault: true } : {}),
          ...(m.provider ? { provider: m.provider.displayName ?? m.provider.id } : {}),
          ...(m.disabled ? { disabled: m.disabled.reason } : {}),
        })),
      };
    },

    async open(options, events) {
      const runtime = lookup(options.harness);
      const install = await installation(runtime);
      requireCompatible(runtime, install);
      // Some harnesses take no appended system prompt (Kimi, DeepSeek Harness, CodeBuddy, Cursor)
      // or no environment for their shell (Cursor, which runs in this process). The guide then
      // rides on the first message of a new session, and tells the agent how to call the CLI
      // without the environment.
      const refused = runtime.refusedSessionOptions ?? {};
      const canAppend = !("appendSystemPrompt" in refused);
      const canEnv = !refusesEnv(runtime);
      const instructions = canEnv
        ? options.appendSystemPrompt
        : `${options.appendSystemPrompt}\n${inlineEnvNote(options.env)}`;
      const base = {
        cwd: options.cwd,
        ...(canAppend ? { appendSystemPrompt: instructions } : {}),
        ...(canEnv ? { env: options.env } : {}),
        ...(options.model ? { model: options.model } : {}),
      };
      let session: Session;
      let resumed = false;
      /** The resumed session keeps the guide it was opened with: none is appended this time. */
      let keptGuide = false;
      try {
        if (options.resume) {
          const opened = await resumeOrReplace(runtime, install, base, options.resume);
          session = opened.session;
          resumed = opened.resumed;
          keptGuide = opened.keptGuide;
        } else {
          session = await runtime.session(install, base);
        }
      } catch (error) {
        // A refusal the declarations did not cover (like OpenCode's version split):
        // report it as incompatibility, not as a raw harness error. The harness's own reason
        // goes into the message so the log says which setting it refused.
        if (error instanceof UnsupportedOptionError) {
          throw new MingleError(
            "harness_incompatible",
            `This harness cannot apply the settings Mingle needs (${error.option}: ${error.message}). Choose another harness.`,
          );
        }
        throw error;
      }

      /** A turn is running: one Mingle prompted, or one the harness began itself. */
      let turn: "prompted" | "self" | undefined;
      /** The open turn showed the model working: reasoning, text or a tool call. */
      let worked = false;
      /** Mingle itself closed the session: its exit event is expected, not a crash. */
      let disposed = false;
      /** Tasks running beside the turns, which an abort of the turn leaves running. */
      const tasks = new Set<string>();
      /** The root agent's tool calls in flight, with the latest input reported for each. */
      const calls = new Map<string, { tool: string; input?: string }>();
      /** Session token totals when the current turn began; the turn's usage is the difference. */
      let turnBase: TurnUsage | undefined;
      const totals = (): TurnUsage => {
        const t = session.usage?.().value.total;
        return {
          input: t?.input ?? 0,
          output: t?.output ?? 0,
          cacheRead: t?.cacheRead ?? 0,
          cacheWrite: t?.cacheWrite ?? 0,
        };
      };
      const reportTurnUsage = () => {
        const base = turnBase;
        turnBase = undefined;
        if (!base) return;
        // OAR retains a complete frame before emitting its events. The ending frame's usage is
        // already in this fold, whether its usage event comes before or after turn_ended.
        const now = totals();
        events.onTurnUsage?.({
          input: now.input - base.input,
          output: now.output - base.output,
          cacheRead: now.cacheRead - base.cacheRead,
          cacheWrite: now.cacheWrite - base.cacheWrite,
        });
      };
      session.events((event) => {
        if (event.kind === "exited") {
          const running = turn;
          const hadTasks = tasks.size > 0;
          turn = undefined;
          tasks.clear();
          calls.clear();
          // An unexpected exit while a turn or background work was open ends it immediately:
          // OAR emits `exited` without `turn_ended`, so otherwise a line or runtime waits forever.
          if (!disposed && (running || hadTasks)) {
            reportTurnUsage();
            const reason =
              event.reason ?? (event.code !== null ? `the harness exited (code ${event.code})` : "the harness exited");
            events.onTurnEnded({ kind: "failed", failure: "runtime_exited", reason });
          }
          return;
        }
        events.onProgress?.();
        switch (event.kind) {
          case "task_started":
            if (!event.ambient) tasks.add(event.taskId);
            return;
          case "task_updated":
            if (event.status === "completed" || event.status === "failed" || event.status === "stopped")
              tasks.delete(event.taskId);
            return;
          case "task_ended":
            tasks.delete(event.taskId);
            return;
        }
        if (event.agentPath.length > 0) return;
        switch (event.kind) {
          case "tool_call_started":
            calls.set(event.callId, { tool: event.tool, ...(event.input ? { input: event.input } : {}) });
            break;
          case "tool_call_input": {
            const call = calls.get(event.callId);
            if (call) calls.set(event.callId, { ...call, input: event.input });
            break;
          }
          case "tool_call_ended": {
            const call = calls.get(event.callId);
            calls.delete(event.callId);
            if (call) events.onAction?.(call.tool, call.input);
            break;
          }
        }
        // Work with no turn open: fallback for harnesses that begin a turn on their own without
        // emitting `turn_active` first.
        const work = event.kind === "tool_call_started" || event.kind === "reasoning" || event.kind === "text_delta";
        if (!turn && work) {
          turn = "self";
          turnBase = totals();
          events.onTurnStarted(true);
        }
        if (work) worked = true;
        switch (event.kind) {
          case "turn_started":
            turn = "prompted";
            worked = false;
            turnBase = totals();
            events.onTurnStarted();
            break;
          case "turn_active":
            // Native active-turn report (e.g. Claude Code waking on a completed background command
            // before the model emits its first token, or a queued input starting its own turn).
            if (!turn) {
              const self = !event.inputId;
              turn = self ? "self" : "prompted";
              worked = false;
              turnBase = totals();
              events.onTurnStarted(self);
            }
            break;
          case "turn_ended": {
            const empty = turn === "prompted" && !worked;
            turn = undefined;
            // Report before onTurnEnded can deliver another input or reopen the session.
            reportTurnUsage();
            const outcome = event.outcome as { kind: string; reason?: string; failure?: Failure; resetsAt?: string };
            const resetsAt = outcome.resetsAt ? Date.parse(outcome.resetsAt) : Number.NaN;
            events.onTurnEnded({
              kind: outcome.kind,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
              ...(outcome.kind === "failed" ? { failure: outcome.failure ?? "unknown" } : {}),
              ...(resetsAt > Date.now() ? { resetsAt } : {}),
              ...(empty && outcome.kind === "completed" ? { empty: true } : {}),
            });
            break;
          }
          case "tool_call_started":
            events.onActivity("tool", (event as { tool?: string }).tool);
            break;
          case "reasoning":
          case "text_delta":
            events.onActivity("thinking");
            break;
        }
      });

      // A resumed session has the guide in its history, or keeps the one it was opened with.
      let primer = canAppend || resumed || keptGuide ? "" : `${instructions.trim()}\n\n---\n\n`;
      return {
        id: session.id,
        resumed,
        async deliver(text, inputId) {
          const result = await session.deliver(primer + text, { inputId, origin: { kind: "user", source: "mingle" } });
          if (result.landed !== "rejected") primer = "";
          return result.landed === "rejected"
            ? { outcome: "rejected", reason: `${result.code}: ${result.reason}` }
            : { outcome: result.landed };
        },
        contextTokens() {
          return session.contextUsage?.().value?.tokens ?? null;
        },
        background() {
          return tasks.size;
        },
        async abort() {
          const running = turn;
          const stopping = [...tasks];
          const [aborted] = await Promise.all([
            running ? session.abort() : undefined,
            ...stopping.map((id) => session.stopTask?.(id).catch(() => undefined)),
          ]);
          // A turn begun by the harness itself that it no longer has (it ended between the
          // last event and the abort, without a turn end): close it here so it cannot stay open.
          if (running === "self" && aborted?.kind === "rejected" && turn === "self") {
            turn = undefined;
            reportTurnUsage();
            events.onTurnEnded({ kind: "aborted" });
          }
          // A task that cannot be stopped on its own still counts: its end can no longer start
          // work, since the runtime aborts a turn the harness begins by itself after a stop.
          return Boolean(running) || stopping.length > 0;
        },
        async dispose() {
          disposed = true;
          await session.dispose();
        },
      };
    },
  };
}

/**
 * The user's login-shell environment, read once by starting their shell without a
 * terminal. Contains secrets: never log it. On failure, the reason only (OAR attaches
 * no shell output), e.g. `unsupported_platform` on Windows, `timed_out`.
 */
export async function loginShellEnvironment(): Promise<
  { readonly env: Readonly<Record<string, string | null>> } | { readonly failed: string }
> {
  try {
    return { env: (await userShellEnvironment()).env };
  } catch (error) {
    return { failed: (error as { reason?: string }).reason ?? "unknown" };
  }
}
