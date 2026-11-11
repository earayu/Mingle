/**
 * The only module that imports OAR. Everything else depends on these types,
 * so an OAR upgrade touches this file alone.
 */
import { type AvailableInstallation, defaultRuntimes, type Runtime, type Session } from "@botiverse/oar";

export interface HarnessInfo {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
}

export interface OpenOptions {
  readonly harness: string;
  readonly model?: string | null;
  readonly cwd: string;
  /** Previous session id. When the harness no longer has it, a fresh session opens instead. */
  readonly resume?: string | null;
  readonly appendSystemPrompt: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface HarnessEvents {
  onTurnStarted(): void;
  onTurnEnded(outcome: { readonly kind: string; readonly reason?: string }): void;
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
  open(options: OpenOptions, events: HarnessEvents): Promise<HarnessSession>;
}

/** Harnesses offered in the console, in display order. Others still work if requested by id. */
const OFFERED = ["claude", "codex", "opencode", "pi", "cursor", "grok", "kimi", "qwen"];

export interface RuntimeSource {
  require(id: string): Runtime;
  list?(): readonly Runtime[];
}

export function oarHarness(source: RuntimeSource = defaultRuntimes): Harness {
  async function installation(runtime: Runtime): Promise<AvailableInstallation> {
    const found = await runtime.installation?.();
    if (found?.kind !== "available") {
      throw new Error(`${runtime.id} is not installed on this computer`);
    }
    return found;
  }

  return {
    async available() {
      const out: HarnessInfo[] = [];
      for (const id of OFFERED) {
        let runtime: Runtime;
        try {
          runtime = source.require(id);
        } catch {
          continue;
        }
        const found = await runtime.installation?.().catch(() => undefined);
        if (found?.kind !== "available") continue;
        const version = found.via === "executable" ? found.version : undefined;
        out.push({ id, name: runtime.brand?.name ?? id, ...(version ? { version } : {}) });
      }
      return out;
    },

    async open(options, events) {
      const runtime = source.require(options.harness);
      const install = await installation(runtime);
      const base = {
        cwd: options.cwd,
        appendSystemPrompt: options.appendSystemPrompt,
        env: options.env,
        ...(options.model ? { model: options.model } : {}),
      };
      let session: Session;
      let resumed = false;
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

      session.events((event) => {
        if (event.agentPath.length > 0) return;
        switch (event.kind) {
          case "turn_started":
            events.onTurnStarted();
            break;
          case "turn_ended": {
            const outcome = event.outcome as { kind: string; reason?: string };
            events.onTurnEnded(
              outcome.reason ? { kind: outcome.kind, reason: outcome.reason } : { kind: outcome.kind },
            );
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
