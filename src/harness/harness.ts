/**
 * The only module that imports OAR. Everything else depends on these types,
 * so an OAR upgrade touches this file alone.
 */
import {
  type AvailableInstallation,
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
  onTurnStarted(): void;
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
  abort(): Promise<void>;
  dispose(): Promise<void>;
}

export interface Harness {
  available(): Promise<HarnessInfo[]>;
  /** The harness's display name ("Claude Code"), for messages to people. */
  name?(id: string): string;
  /** What can go in `OpenOptions.model`. Asks the harness, so it can take seconds. */
  models?(id: string): Promise<ModelList>;
  open(options: OpenOptions, events: HarnessEvents): Promise<HarnessSession>;
}

/** Harnesses offered in the console, in display order. Others still work if requested by id. */
const OFFERED = ["claude", "codex", "opencode", "pi", "cursor", "grok", "kimi", "qwen"];

export interface RuntimeSource {
  require(id: string): Runtime;
  list?(): readonly Runtime[];
}

/**
 * Whether an installed harness can serve Mingle, from the runtime's own
 * declarations. Mingle needs `appendSystemPrompt` (role and operating guide)
 * and a non-empty `env` (API address and token), so a declared refusal of
 * either blocks it. OAR's declarations do not cover OpenCode's version
 * difference (1.x supports appended prompts, 2.x refuses them), so OpenCode
 * also gets a version check here.
 */
function incompatibility(runtime: Runtime, install: AvailableInstallation): HarnessInfo["disabled"] {
  if (runtime.refusedSessionOptions?.appendSystemPrompt !== undefined) {
    return {
      code: "harness_prompt_unsupported",
      reason: "This harness cannot receive the agent's role and operating guide. Choose another harness.",
    };
  }
  if (runtime.refusedSessionOptions?.env !== undefined) {
    return {
      code: "harness_env_unsupported",
      reason: "This harness cannot receive the connection settings needed to reply in chat. Choose another harness.",
    };
  }
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

export function oarHarness(source: RuntimeSource = defaultRuntimes): Harness {
  async function installation(runtime: Runtime): Promise<AvailableInstallation> {
    const found = await runtime.installation?.();
    if (found?.kind !== "available") {
      throw new HarnessError("not_installed", `${runtime.id} is not installed on this computer`);
    }
    return found;
  }

  return {
    async available() {
      // Each probe starts the harness's executable for its version; run them side by side.
      const probes = OFFERED.map(async (id): Promise<HarnessInfo | undefined> => {
        let runtime: Runtime;
        try {
          runtime = source.require(id);
        } catch {
          return undefined;
        }
        const found = await runtime.installation?.().catch(() => undefined);
        if (found?.kind !== "available") return undefined;
        // Harnesses print versions their own way ("2.1.322 (Claude Code)", "codex-cli 0.167.1"): keep the number.
        const version = found.via === "executable" ? /\d+(?:\.\d+)+/.exec(found.version ?? "")?.[0] : undefined;
        const brand = runtime.brand;
        const light = brand ? runtimeBrandIcon(brand, "light") : null;
        const dark = brand ? runtimeBrandIcon(brand, "dark") : null;
        const disabled = incompatibility(runtime, found);
        return {
          id,
          name: brand?.name ?? id,
          ...(version ? { version } : {}),
          ...(light && dark ? { icon: { light, dark } } : {}),
          ...(disabled ? { disabled } : {}),
        };
      });
      return (await Promise.all(probes)).filter((h): h is HarnessInfo => h !== undefined);
    },

    name(id) {
      try {
        return source.require(id).brand?.name ?? id;
      } catch {
        return id;
      }
    },

    async models(id) {
      const runtime = source.require(id);
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
      const runtime = source.require(options.harness);
      const install = await installation(runtime);
      requireCompatible(runtime, install);
      const base = {
        cwd: options.cwd,
        appendSystemPrompt: options.appendSystemPrompt,
        env: options.env,
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

      session.events((event) => {
        if (event.agentPath.length > 0) return;
        switch (event.kind) {
          case "turn_started":
            events.onTurnStarted();
            break;
          case "turn_ended": {
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

      return {
        id: session.id,
        resumed,
        async deliver(text, inputId) {
          const result = await session.deliver(text, { inputId, origin: { kind: "user", source: "mingle" } });
          return result.landed === "rejected"
            ? { outcome: "rejected", reason: `${result.code}: ${result.reason}` }
            : { outcome: result.landed };
        },
        async abort() {
          await session.abort();
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
