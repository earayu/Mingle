import { randomUUID } from "node:crypto";
import type { Harness, HarnessSession } from "../harness/harness.ts";
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
  readonly onSettled?: (messageIds: readonly string[], outcome: "unanswered" | "failed") => void;
  /** Wait before delivering to an idle agent, so a burst of messages becomes one input. */
  readonly coalesceMs?: number;
  readonly log?: (line: string) => void;
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
      // Keep the messages as "received": they are retried on the next message or restart.
      this.pending.unshift(...batch);
      throw error;
    }
    const inputId = randomUUID();
    // Mark first: a fast agent can reply before deliver() returns, and its reply must win.
    this.deps.store.setInboundState(messageIds, "delivered", inputId);
    let result: Awaited<ReturnType<HarnessSession["deliver"]>>;
    try {
      result = await session.deliver(text, inputId);
    } catch (error) {
      this.deps.store.setInboundState(messageIds, "received");
      this.pending.unshift(...batch);
      throw error;
    }
    if (result.outcome === "rejected") {
      this.deps.store.setInboundState(messageIds, "received");
      this.pending.unshift(...batch);
      throw new Error(`the harness refused the input (${result.reason ?? "no reason"})`);
    }
    this.deps.log?.(`${this.agentId}: delivered ${messageIds.join(",") || "note"} (${result.outcome})`);
  }

  private render(messageId: string): string {
    const { store } = this.deps;
    const message = store.message(messageId);
    const chat = message && store.chat(message.chatId);
    const connection = chat && store.connection(chat.connectionId);
    if (!message || !chat || !connection) return "";
    return formatMessage(message, chat, connection.platform, { ownerId: connection.ownerId });
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
          if (outcome.kind === "failed") this.setStatus("error", outcome.reason ?? "the turn failed");
          else this.setStatus("idle");
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

  private setStatus(status: AgentStatus, detail: string | null = null): void {
    if (this.status === status && status !== "working" && status !== "error") return;
    this.status = status;
    this.deps.store.setAgentStatus(this.agentId, status, detail);
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
    this.setStatus("error", message);
    const lost = this.deps.store.awaitingReply(this.agentId).map((m) => m.id);
    if (lost.length > 0) this.deps.onSettled?.(lost, "failed");
  }
}
