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
}

export type DeliverOutcome = "prompted" | "steered" | "queued" | "rejected";

export interface HarnessSession {
  readonly id: string;
  /** True when this open resumed `resume`; false when a fresh session replaced it. */
  readonly resumed: boolean;
  deliver(text: string, inputId: string): Promise<{ outcome: DeliverOutcome; reason?: string }>;
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
}

export type SignInState =
  | { readonly kind: "signed_in"; readonly account?: string; readonly plan?: string }
  | { readonly kind: "signed_out"; readonly detail?: string }
  | { readonly kind: "unknown" };

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
  async function installation(runtime: Runtime): Promise<AvailableInstallation> {
    const found = await runtime.installation?.();
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

  return {
    async available() {
      return (await this.catalog?.())?.filter((h) => h.installed) ?? [];
    },

    async catalog() {
      // Each probe starts the harness's executable for its version; run them side by side.
      return Promise.all(
        ids().map(async (id): Promise<HarnessStatus> => {
          const runtime = lookup(id);
          const found = await runtime.installation?.().catch(() => undefined);
          const available = found?.kind === "available" ? found : undefined;
          const disabled = available ? incompatibility(runtime, available) : undefined;
          return {
            ...info(id, runtime, available),
            ...(disabled ? { disabled } : {}),
            installed: Boolean(available),
            ...(found?.kind === "unsupported" ? { unsupported: found.reason } : {}),
            canInstall: Boolean(runtime.install),
            canSignIn: Boolean(runtime.login),
          };
        }),
      );
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
      if (result.kind === "installed" || result.kind === "already_installed") return { ok: true };
      if (result.kind === "failed") return { ok: false, detail: result.output.trim().split("\n").slice(-6).join("\n") };
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
      try {
        if (options.resume) {
          try {
            session = await runtime.session(install, { ...base, resume: options.resume });
            resumed = true;
          } catch (error) {
            if ((error as Error).name !== "SessionNotFoundError") throw error;
            session = await runtime.session(install, base);
          }
        } else {
          session = await runtime.session(install, base);
        }
      } catch (error) {
        // A refusal the declarations did not cover (like OpenCode's version split):
        // report it as incompatibility, not as a raw harness error.
        if (error instanceof UnsupportedOptionError) {
          throw new MingleError(
            "harness_incompatible",
            "This harness cannot apply the settings Mingle needs. Choose another harness.",
          );
        }
        throw error;
      }

      /** A turn is running: one Mingle prompted, or one the harness began itself. */
      let turn: "prompted" | "self" | undefined;
      /** Tasks running beside the turns, which an abort of the turn leaves running. */
      const tasks = new Set<string>();
      session.events((event) => {
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
        // Work with no turn open: the harness began a turn on its own (Claude Code wakes the
        // agent when a background command ends). OAR reports turn starts for prompts only.
        if (
          !turn &&
          (event.kind === "tool_call_started" || event.kind === "reasoning" || event.kind === "text_delta")
        ) {
          turn = "self";
          events.onTurnStarted(true);
        }
        switch (event.kind) {
          case "turn_started":
            turn = "prompted";
            events.onTurnStarted();
            break;
          case "turn_ended": {
            turn = undefined;
            const outcome = event.outcome as { kind: string; reason?: string; failure?: Failure; resetsAt?: string };
            const resetsAt = outcome.resetsAt ? Date.parse(outcome.resetsAt) : Number.NaN;
            events.onTurnEnded({
              kind: outcome.kind,
              ...(outcome.reason ? { reason: outcome.reason } : {}),
              ...(outcome.kind === "failed" ? { failure: outcome.failure ?? "unknown" } : {}),
              ...(resetsAt > Date.now() ? { resetsAt } : {}),
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

      // A resumed session has the guide in its history already.
      let primer = canAppend || resumed ? "" : `${instructions.trim()}\n\n---\n\n`;
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
            events.onTurnEnded({ kind: "aborted" });
          }
          // A task that cannot be stopped on its own still counts: its end can no longer start
          // work, since the runtime aborts a turn the harness begins by itself after a stop.
          return Boolean(running) || stopping.length > 0;
        },
        async dispose() {
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
