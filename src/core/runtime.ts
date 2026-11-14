import { randomUUID } from "node:crypto";
import { type Failure, failureOf, type Harness, type HarnessSession } from "../harness/harness.ts";
import type { Agent, AgentStatus, Store } from "../store/store.ts";
import { formatMessage } from "./format.ts";
import { memoryHint, memoryHintDue, memorySize, readRole } from "./home.ts";
import { renderManual } from "./manual.ts";

export interface RuntimeDeps {
  readonly store: Store;
  readonly harness: Harness;
  readonly homeDir: string;
  /** Environment for the harness process: API address, token, CLI path. */
  readonly env: () => Readonly<Record<string, string>>;
  /**
   * The agent's own variables, read from the secret store each time a session opens.
   * Undefined when it has none, so opening then takes no extra turn of the event loop.
   */
  readonly agentEnv?: () => Promise<Readonly<Record<string, string>>> | undefined;
  /** Progress inside a turn, for live replies. */
  readonly onActivity?: (kind: "thinking" | "tool", detail?: string) => void;
  /** Messages that will not be answered: given up on after the nudge, or lost to a failed turn. */
  readonly onSettled?: (messageIds: readonly string[], outcome: "unanswered" | "failed", why?: FailureInfo) => void;
  /** Wait before delivering to an idle agent, so a burst of messages becomes one input. */
  readonly coalesceMs?: number;
  readonly log?: (line: string) => void;
}

/** Why messages were lost to a failure: its class and, for quota, when the limit resets. */
export interface FailureInfo {
  readonly failure: Failure;
  readonly resetsAt?: number;
}

type Pending = { readonly kind: "message"; readonly id: string } | { readonly kind: "text"; readonly text: string };

/**
 * One agent, one long-lived harness session (docs/spec.md 4.1–4.3).
 *
 * Messages are pushed into the session: when idle, a short window collects a
 * burst into one new turn; while running, each delivery is steered into the
 * current turn (or queued when the harness cannot steer).
 */
export class AgentRuntime {
  private session: HarnessSession | undefined;
  private opening: Promise<HarnessSession> | undefined;
  private running = false;
  private pending: Pending[] = [];
  private timer: NodeJS.Timeout | undefined;
  private chain: Promise<void> = Promise.resolve();
  private status: AgentStatus | undefined;
  private disposed = false;
  /** The agent's variables changed during a turn: reopen once it ends. */
  private stale = false;
  /**
   * The owner stopped the agent's work and nothing has been delivered since. A turn the harness
   * begins on its own now (a background command finishing) is aborted, and the agent cannot send.
   */
  private stopped = false;
  /** Messages the owner asked to try again; their next delivery says so. */
  private readonly retried = new Set<string>();

  private readonly agentId: string;
  private readonly deps: RuntimeDeps;

  constructor(agentId: string, deps: RuntimeDeps) {
    this.agentId = agentId;
    this.deps = deps;
  }

  get id(): string {
    return this.agentId;
  }

  get busy(): boolean {
    return this.running;
  }

  /**
   * Resume pending work after a restart. `after`: wait for it before opening, e.g. for the
   * previous session of this agent to close, so there are never two.
   */
  start(after?: Promise<void>): void {
    this.setStatus("idle");
    // Open the session now, not on the first message: startup problems (login,
    // a refused option) surface before anyone chats. No input is delivered here.
    this.chain = this.chain
      .then(() => after)
      .then(async () => {
        if (this.disposed) return;
        await this.ensureSession();
        this.setStatus("idle");
      })
      .catch((error) => this.fail(error));
    for (const message of this.deps.store.undelivered(this.agentId)) this.enqueueMessage(message.id);
  }

  enqueueMessage(messageId: string): void {
    this.pending.push({ kind: "message", id: messageId });
    this.schedule();
  }

  /** Deliver messages again that were given up on. The store already has them back as received. */
  retry(messageIds: readonly string[]): void {
    for (const id of messageIds) {
      this.retried.add(id);
      this.enqueueMessage(id);
    }
  }

  /** Input that is not a chat message: a reminder firing, or a note from Mingle itself. */
  enqueueText(text: string): void {
    this.pending.push({ kind: "text", text });
    this.schedule();
  }

  /** True between an owner's stop and the next input Mingle delivers: the agent may not send. */
  get halted(): boolean {
    return this.stopped;
  }

  /**
   * Stop the agent's work: the current turn and the background tasks it left running, so
   * none of it answers later. Messages in that turn are not nudged about; pending messages
   * stay pending and are delivered as usual. False when there was nothing to stop.
   */
  async stop(): Promise<boolean> {
    if (!this.session) return false;
    // Set before aborting: the harness may begin a turn of its own while the abort is under way.
    this.stopped = true;
    const stopped = (await this.session.abort()) || this.running;
    if (!stopped) this.stopped = false;
    return stopped;
  }

  /** Reopen the session with fresh settings (role or harness changed), serialized with delivery. */
  async restart(): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const session = this.session;
        this.session = undefined;
        this.stale = false;
        this.running = false;
        await session?.dispose().catch(() => {});
        if (this.disposed) return;
        await this.ensureSession();
        this.setStatus("idle");
        // Messages that arrived while the brain was broken still need delivering.
        if (this.pending.length > 0) this.flushSoon();
      })
      .catch((error) => this.fail(error));
    await this.chain;
  }

  /**
   * The agent's variables changed. They reach the harness when its process starts, so reopen
   * (resuming the same conversation) now if idle, or after the current turn: never mid-work.
   */
  async refresh(): Promise<void> {
    if (this.running) {
      this.stale = true;
      return;
    }
    await this.restart();
  }

  /**
   * Close the session for good. `final` is the status it leaves behind: offline when Mingle stops
   * or the agent is deleted, paused when the owner pauses it. Nothing the session reports after
   * this point changes the status.
   */
  async dispose(final: "offline" | "paused" = "offline"): Promise<void> {
    this.disposed = true;
    clearTimeout(this.timer);
    this.pending = [];
    // Written now, not after the session is gone: closing can wait on a session still opening.
    this.deps.store.setAgentStatus(this.agentId, final);
    // Pausing ends the work in hand; the session is closed right after.
    if (final === "paused" && this.running) await this.session?.abort().catch(() => {});
    await this.chain.catch(() => {});
    await this.session?.dispose().catch(() => {});
    this.session = undefined;
    this.running = false;
  }

  private schedule(): void {
    if (this.disposed) return;
    if (this.running) {
      this.flushSoon();
      return;
    }
    this.timer ??= setTimeout(() => this.flushSoon(), this.deps.coalesceMs ?? 1000);
  }

  private flushSoon(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.chain = this.chain.then(() => this.flush()).catch((error) => this.fail(error));
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0 || this.disposed) return;
    // While a turn runs, only chat messages are steered in. Reminders and notes wait for the
    // next turn: steered at the very end of a turn they could be accepted and never acted on.
    // (A message in that position is still caught by the unanswered check after the turn.)
    const taken = this.running ? this.pending.filter((p) => p.kind === "message") : this.pending.slice();
    this.pending = this.running ? this.pending.filter((p) => p.kind !== "message") : [];
    // A message settled while it waited (answered, or queued twice) is not delivered again.
    const batch = taken.filter((p) => p.kind === "text" || this.deps.store.message(p.id)?.state === "received");
    if (batch.length === 0) return;

    let session: HarnessSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      this.lose(batch, error);
      throw error;
    }
    const inputId = randomUUID();
    // New input: whatever comes next is work Mingle asked for, not the stopped work resuming.
    this.stopped = false;
    // Mark first: a fast agent can reply before deliver() returns, and its reply must win.
    const delivered = new Set(
      this.deps.store.moveInbound(
        batch.flatMap((p) => (p.kind === "message" ? [p.id] : [])),
        "deliver",
        inputId,
      ),
    );
    const messageIds = [...delivered];
    const text = batch
      .flatMap((p) => (p.kind === "text" ? [p.text] : delivered.has(p.id) ? [this.render(p.id)] : []))
      .filter(Boolean)
      .join("\n\n");
    if (!text) return;
    let result: Awaited<ReturnType<HarnessSession["deliver"]>>;
    try {
      result = await session.deliver(text, inputId);
    } catch (error) {
      this.lose(batch, error);
      throw error;
    }
    if (result.outcome === "rejected") {
      const error = new Error(`the harness refused the input (${result.reason ?? "no reason"})`);
      this.lose(batch, error);
      throw error;
    }
    this.deps.log?.(`${this.agentId}: delivered ${messageIds.join(",") || "note"} (${result.outcome})`);
  }

  /**
   * Input that could not be handed over. Chat messages settle as failed, so the person
   * hears about it instead of waiting; reminders and notes wait for the next turn.
   */
  private lose(batch: readonly Pending[], error: unknown): void {
    this.pending.unshift(...batch.filter((p) => p.kind === "text"));
    const ids = this.deps.store.moveInbound(
      batch.flatMap((p) => (p.kind === "message" ? [p.id] : [])),
      "fail",
    );
    if (ids.length === 0) return;
    this.deps.onSettled?.(ids, "failed", { failure: failureOf(error) });
  }

  private render(messageId: string): string {
    const { store } = this.deps;
    const message = store.message(messageId);
    const chat = message && store.chat(message.chatId);
    const connection = chat && store.connection(chat.connectionId);
    if (!message || !chat || !connection) return "";
    const contact = message.senderId ? store.contactByPlatformId(chat.connectionId, message.senderId) : undefined;
    const text = formatMessage(message, chat, connection.platform, { ownerId: connection.ownerId, contact });
    if (!this.retried.delete(messageId)) return text;
    // An old message coming back: the agent should know it is late, not treat it as new.
    return `[mingle] Retry: ${message.id} was not answered when it arrived (see its time). Reply to it now, and say briefly that the answer is late.\n${text}`;
  }

  private async ensureSession(): Promise<HarnessSession> {
    if (this.session) return this.session;
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<HarnessSession> {
    const agent = this.agent();
    // A harness whose shell gets no environment (Cursor) gets none of the agent's variables
    // either, and the guide does not name them. Values never go into the prompt.
    const reading = this.deps.harness.acceptsEnv?.(agent.harness) === false ? undefined : this.deps.agentEnv?.();
    const own = reading ? await reading : {};
    const session = await this.deps.harness.open(
      {
        harness: agent.harness,
        model: agent.model,
        cwd: this.deps.homeDir,
        resume: agent.sessionId,
        appendSystemPrompt: renderManual(agent.name, readRole(this.deps.homeDir), process.platform, Object.keys(own)),
        // Mingle's own variables win over the agent's.
        env: { ...own, ...this.deps.env() },
      },
      {
        onTurnStarted: (self) => {
          if (self && this.stopped) {
            // The stopped work coming back (a background command ended and woke the agent).
            this.deps.log?.(`${this.agentId}: aborted a turn the harness began after a stop`);
            void this.session?.abort().catch(() => {});
          }
          this.running = true;
          this.setStatus("thinking");
          this.deps.onActivity?.("thinking");
        },
        onTurnEnded: (outcome) => {
          this.running = false;
          if (outcome.kind === "failed") {
            const failure = outcome.failure ?? "unknown";
            this.setStatus("error", outcome.reason ?? "the turn failed", failure);
            // The agent did not get to answer: say so now rather than nudge it into the same failure.
            this.settleAwaiting({ failure, ...(outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}) });
          } else {
            this.setStatus("idle");
          }
          this.afterTurn(outcome.kind === "completed");
        },
        onActivity: (kind, detail) => {
          this.setStatus(kind === "tool" ? "working" : "thinking", detail ?? null);
          this.deps.onActivity?.(kind, detail);
        },
      },
    );
    if (this.disposed) {
      // Stopped or deleted while the open was in flight: drop it, don't keep it.
      await session.dispose();
      throw new Error("agent runtime disposed");
    }
    if (agent.sessionId && !session.resumed) {
      this.deps.log?.(`${this.agentId}: session ${agent.sessionId} was gone; opened ${session.id}`);
    }
    this.deps.store.setSessionId(this.agentId, session.id);
    this.session = session;
    return session;
  }

  /** After each turn: remind the agent once about messages it has not answered (docs/spec.md 4.3). */
  private afterTurn(completed = false): void {
    const { store } = this.deps;
    const awaiting = store.awaitingReply(this.agentId);
    // After the owner's stop, a nudge would restart the work they stopped: what is
    // unanswered is marked so at once, for the owner to retry or ignore.
    const fresh = this.stopped ? [] : awaiting.filter((m) => !store.wasNudged(m.id));
    const stale = this.stopped ? awaiting : awaiting.filter((m) => store.wasNudged(m.id));
    const givenUp = store.moveInbound(
      stale.map((m) => m.id),
      "give_up",
    );
    if (givenUp.length > 0) this.deps.onSettled?.(givenUp, "unanswered");
    if (fresh.length > 0) {
      store.markNudged(fresh.map((m) => m.id));
      const ids = fresh.map((m) => m.id).join(", ");
      this.pending.push({
        kind: "text",
        text: `[mingle] Not answered yet: ${ids}. Reply to each with "$MINGLE_CLI" message reply <id>, or send a short note if no reply is needed.`,
      });
    }
    // Only after work that finished, with nothing else waiting: the hint never interrupts or joins other work.
    if (completed && !this.stopped && this.pending.length === 0) this.checkMemory();
    if (this.stale) {
      // restart() delivers what is pending once the new process is up.
      void this.restart();
      return;
    }
    if (this.pending.length > 0) this.flushSoon();
  }

  /** Ask the agent to trim MEMORY.md when it has grown too large (docs/spec.md 4.5). */
  private checkMemory(): void {
    const size = memorySize(this.deps.homeDir);
    const now = Date.now();
    if (!memoryHintDue(size, this.deps.store.memoryHint(this.agentId), now)) return;
    this.deps.store.setMemoryHint(this.agentId, now, size);
    this.deps.log?.(`${this.agentId}: MEMORY.md is ${size} bytes; asked the agent to trim it`);
    this.pending.push({ kind: "text", text: memoryHint(size) });
  }

  private agent(): Agent {
    const agent = this.deps.store.agent(this.agentId);
    if (!agent) throw new Error(`agent ${this.agentId} no longer exists`);
    return agent;
  }

  private setStatus(status: AgentStatus, detail: string | null = null, failure: Failure | null = null): void {
    // A late report from a closed session (a turn ending after it was aborted) must not overwrite
    // the status dispose() left: a paused agent stays paused.
    if (this.disposed) return;
    if (this.status === status && status !== "working" && status !== "error") return;
    this.status = status;
    this.deps.store.setAgentStatus(this.agentId, status, detail, failure);
  }

  /** Every message still waiting on this agent fails with `why`. */
  private settleAwaiting(why: FailureInfo): void {
    const lost = this.deps.store.moveInbound(
      this.deps.store.awaitingReply(this.agentId).map((m) => m.id),
      "fail",
    );
    if (lost.length === 0) return;
    this.deps.onSettled?.(lost, "failed", why);
  }

  private fail(error: unknown): void {
    if (this.disposed) return; // A stopped or deleted agent stays offline, not error.
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log?.(`${this.agentId}: ${message}`);
    // Reopen (resuming the same conversation) on the next input.
    const session = this.session;
    this.session = undefined;
    this.running = false;
    void session?.dispose().catch(() => {});
    const failure = failureOf(error);
    this.setStatus("error", message, failure);
    this.settleAwaiting({ failure });
  }
}
