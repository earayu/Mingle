import { randomUUID } from "node:crypto";
import { type Failure, failureOf, type Harness, type HarnessSession } from "../harness/harness.ts";
import type { Agent, AgentStatus, Store } from "../store/store.ts";
import { formatMessage } from "./format.ts";
import { readRole } from "./home.ts";
import { renderManual } from "./manual.ts";

export interface RuntimeDeps {
  readonly store: Store;
  readonly harness: Harness;
  readonly homeDir: string;
  /** Environment for the harness process: API address, token, CLI path. */
  readonly env: () => Readonly<Record<string, string>>;
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

  /** Resume pending work after a restart. */
  start(): void {
    this.setStatus("idle");
    // Open the session now, not on the first message: startup problems (login,
    // a refused option) surface before anyone chats. No input is delivered here.
    this.chain = this.chain
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

  /** Abort the current turn. Pending messages stay pending. */
  async stop(): Promise<boolean> {
    if (!this.session || !this.running) return false;
    await this.session.abort();
    return true;
  }

  /** Reopen the session with fresh settings (role or harness changed), serialized with delivery. */
  async restart(): Promise<void> {
    this.chain = this.chain
      .then(async () => {
        const session = this.session;
        this.session = undefined;
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

  async dispose(): Promise<void> {
    this.disposed = true;
    clearTimeout(this.timer);
    await this.chain.catch(() => {});
    await this.session?.dispose().catch(() => {});
    this.session = undefined;
    this.setStatus("offline");
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
    const batch = this.running ? this.pending.filter((p) => p.kind === "message") : this.pending.slice();
    this.pending = this.running ? this.pending.filter((p) => p.kind !== "message") : [];
    if (batch.length === 0) return;
    const messageIds = batch.flatMap((p) => (p.kind === "message" ? [p.id] : []));
    const text = batch
      .map((p) => (p.kind === "text" ? p.text : this.render(p.id)))
      .filter(Boolean)
      .join("\n\n");
    if (!text) return;

    let session: HarnessSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      this.lose(batch, error);
      throw error;
    }
    const inputId = randomUUID();
    // Mark first: a fast agent can reply before deliver() returns, and its reply must win.
    this.deps.store.setInboundState(messageIds, "delivered", inputId);
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
    const ids = batch.flatMap((p) => (p.kind === "message" ? [p.id] : []));
    this.pending.unshift(...batch.filter((p) => p.kind === "text"));
    if (ids.length === 0) return;
    this.deps.store.setInboundState(ids, "failed");
    this.deps.onSettled?.(ids, "failed", { failure: failureOf(error) });
  }

  private render(messageId: string): string {
    const { store } = this.deps;
    const message = store.message(messageId);
    const chat = message && store.chat(message.chatId);
    const connection = chat && store.connection(chat.connectionId);
    if (!message || !chat || !connection) return "";
    const text = formatMessage(message, chat, connection.platform, { ownerId: connection.ownerId });
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
    const session = await this.deps.harness.open(
      {
        harness: agent.harness,
        model: agent.model,
        cwd: this.deps.homeDir,
        resume: agent.sessionId,
        appendSystemPrompt: renderManual(agent.name, readRole(this.deps.homeDir)),
        env: this.deps.env(),
      },
      {
        onTurnStarted: () => {
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
          this.afterTurn();
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
  private afterTurn(): void {
    const { store } = this.deps;
    const awaiting = store.awaitingReply(this.agentId);
    const fresh = awaiting.filter((m) => !store.wasNudged(m.id));
    const stale = awaiting.filter((m) => store.wasNudged(m.id));
    store.setInboundState(
      stale.map((m) => m.id),
      "unanswered",
    );
    if (stale.length > 0)
      this.deps.onSettled?.(
        stale.map((m) => m.id),
        "unanswered",
      );
    if (fresh.length > 0) {
      store.markNudged(fresh.map((m) => m.id));
      const ids = fresh.map((m) => m.id).join(", ");
      this.pending.push({
        kind: "text",
        text: `[mingle] Not answered yet: ${ids}. Reply to each with "$MINGLE_CLI" message reply <id>, or send a short note if no reply is needed.`,
      });
    }
    if (this.pending.length > 0) this.flushSoon();
  }

  private agent(): Agent {
    const agent = this.deps.store.agent(this.agentId);
    if (!agent) throw new Error(`agent ${this.agentId} no longer exists`);
    return agent;
  }

  private setStatus(status: AgentStatus, detail: string | null = null, failure: Failure | null = null): void {
    if (this.status === status && status !== "working" && status !== "error") return;
    this.status = status;
    this.deps.store.setAgentStatus(this.agentId, status, detail, failure);
  }

  /** Every message still waiting on this agent fails with `why`. */
  private settleAwaiting(why: FailureInfo): void {
    const lost = this.deps.store.awaitingReply(this.agentId).map((m) => m.id);
    if (lost.length === 0) return;
    this.deps.store.setInboundState(lost, "failed");
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
