import { randomUUID } from "node:crypto";
import { type Failure, failureOf, type Harness, type HarnessSession } from "../harness/harness.ts";
import type { Agent, AgentStatus, Store } from "../store/store.ts";
import { renderMessage } from "./format.ts";
import { MEMORY_LIMIT, memoryHint, memoryHintDue, memorySize, readRole } from "./home.ts";
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
  readonly onSettled?: (
    messageIds: readonly string[],
    outcome: "unanswered" | "failed" | "waiting",
    why?: FailureInfo,
  ) => void;
  /**
   * Whose usage limit this agent's next session shares: the ledger key (docs/spec.md 4.3).
   * Read again at each open; configuration changes apply to the next session, never mid-turn.
   */
  readonly signIn: () => string;
  /** The current ledger revision of `key`, or undefined while it has no wait. */
  readonly limitRevision: (key: string) => number | undefined;
  /**
   * A session is about to open with sign-in `key`. `changed` is true when it opens on a
   * different sign-in than the session it replaces.
   */
  readonly onSession: (key: string, changed: boolean) => void;
  /**
   * A session on sign-in `key` hit a usage limit and now waits until `until`. Mingle holds the
   * other agents on the same sign-in too: the limit belongs to the account, not to one agent.
   */
  readonly onLimit?: (key: string, until: number, why: FailureInfo) => void;
  /**
   * A turn on sign-in `key` completed: its account works again. `revision` is the ledger
   * revision the turn began with, so a newer quota report is not cleared by an older success.
   */
  readonly onTurnCompleted?: (key: string, revision: number | undefined) => void;
  /** Wait before delivering to an idle agent, so a burst of messages becomes one input. */
  readonly coalesceMs?: number;
  readonly log?: (line: string) => void;
}

/** Why messages were lost to a failure: its class and, for quota, when the limit resets. */
export interface FailureInfo {
  readonly failure: Failure;
  readonly resetsAt?: number;
  /** For messages left waiting: when Mingle delivers them again. */
  readonly retryAt?: number;
}

/** Waits between tries for a busy or rate-limited provider; after the last, the message fails. */
export const BUSY_RETRY_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000];
/** A usage limit is waited out at most this long at a time, then tried again (and waited again). */
export const QUOTA_WAIT_MS = 3_600_000;
/** A little past the reported reset, so the first try after it is not refused again. */
const QUOTA_MARGIN_MS = 15_000;
/** A usage limit that keeps coming back this many times is no longer waited for. */
const MAX_QUOTA_HOLDS = 200;
/**
 * Waits for a usage limit whose reset the harness did not report: longer each time, then hourly,
 * for about a day in all (Raft does the same rather than failing at once). The last entry repeats.
 */
export const QUOTA_UNKNOWN_RETRY_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000];
const MAX_QUOTA_UNKNOWN_HOLDS = 24;

/**
 * When to deliver a message again after `why`, or undefined when it should fail and wait for the
 * owner (docs/spec.md 4.3). Only failures that pass by themselves wait: a usage limit with a
 * known reset, a rate limit, a busy or failing provider. A sign-in, payment or missing harness
 * needs a person, so those fail at once. `holds`: how many times the message already waited.
 */
export function holdUntil(why: FailureInfo, holds: number, now: number): number | undefined {
  switch (why.failure) {
    case "quota":
      if (why.resetsAt && why.resetsAt > now) {
        return holds >= MAX_QUOTA_HOLDS ? undefined : Math.min(why.resetsAt + QUOTA_MARGIN_MS, now + QUOTA_WAIT_MS);
      }
      // No (future) reset reported: still a limit that passes, so wait, longer each time.
      if (holds >= MAX_QUOTA_UNKNOWN_HOLDS) return undefined;
      return now + (QUOTA_UNKNOWN_RETRY_MS[holds] ?? (QUOTA_UNKNOWN_RETRY_MS.at(-1) as number));
    case "rate_limited":
    case "overloaded":
    case "provider": {
      const wait = BUSY_RETRY_MS[holds];
      return wait === undefined ? undefined : now + wait;
    }
    default:
      return undefined;
  }
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
  /**
   * The local delivery gate: new messages wait until then instead of failing again. Mingle's
   * account ledger decides when it ends; the owner can still bypass it with a manual retry.
   */
  private blocked: { until: number; why: FailureInfo } | undefined;
  /** The ledger revision the running turn began with, so it clears only the wait it knew. */
  private turnRevision: number | undefined;
  private unblockTimer: NodeJS.Timeout | undefined;
  /** The sign-in the open session runs on; events report under it, whatever config changes to. */
  private sessionSignIn: string;
  /** Bumped when a session is replaced or disposed: a retired session's events are dropped. */
  private generation = 0;

  private readonly agentId: string;
  private readonly deps: RuntimeDeps;

  constructor(agentId: string, deps: RuntimeDeps) {
    this.agentId = agentId;
    this.deps = deps;
    this.sessionSignIn = deps.signIn();
  }

  get id(): string {
    return this.agentId;
  }

  /** The sign-in the open session reports under; configuration changes apply to the next open. */
  get signIn(): string {
    return this.sessionSignIn;
  }

  get busy(): boolean {
    return this.running;
  }

  /**
   * Resume pending work after a restart. `after`: wait for it before opening, e.g. for the
   * previous session of this agent to close, so there are never two.
   */
  start(after?: Promise<void>): void {
    // Account waits live in Mingle's ledger; start() restores nothing by itself (docs/spec.md 4.3).
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

  /**
   * Deliver messages again that were given up on or waited. The store already has them back as
   * received. A retry is a request to try now, so it does not wait out a usage limit.
   */
  retry(messageIds: readonly string[]): void {
    if (messageIds.length === 0) return;
    this.unblock();
    this.resume(messageIds);
  }

  /** A scheduled retry must respect a newer provider-wide quota wait. */
  resume(messageIds: readonly string[], now = Date.now()): void {
    if (this.blocked && this.blocked.until <= now) this.unblock();
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
        // The old session's events are ignored from here on (docs/spec.md 4.3).
        this.generation++;
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

  /** Preserve queued reminders and system notes when replacing a session. */
  takePendingNotes(): string[] {
    const notes = this.pending.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    this.pending = this.pending.filter((p) => p.kind !== "text");
    return notes;
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
  async dispose(final: "offline" | "paused" = "offline", abortWork = false): Promise<void> {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
    this.unblock();
    this.pending = [];
    // Written now, not after the session is gone: closing can wait on a session still opening.
    this.deps.store.setAgentStatus(this.agentId, final);
    // Pausing ends the work in hand; the session is closed right after.
    if (abortWork || (final === "paused" && this.running)) await this.session?.abort().catch(() => {});
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
    if (this.blocked && Date.now() >= this.blocked.until) this.unblock();
    if (this.holdBatch(batch)) return;

    let session: HarnessSession;
    try {
      session = await this.ensureSession();
    } catch (error) {
      this.lose(batch, error);
      throw error;
    }
    if (this.disposed) return;
    // A shared or newly configured quota wait may have appeared while the session opened:
    // hold the batch through the same path rather than deliver into another refusal.
    if (this.blocked && Date.now() >= this.blocked.until) this.unblock();
    if (this.holdBatch(batch)) return;
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
    if (this.disposed) return;
    this.pending.unshift(...batch.filter((p) => p.kind === "text"));
    this.settleLost(
      batch.flatMap((p) => (p.kind === "message" ? [p.id] : [])),
      { failure: failureOf(error) },
    );
  }

  /**
   * Messages the agent could not answer because of `why`: each waits and is delivered again when
   * the failure passes by itself, or fails for the owner to retry or ignore (docs/spec.md 4.3).
   */
  private settleLost(ids: readonly string[], why: FailureInfo): void {
    if (this.disposed || ids.length === 0) return;
    const now = Date.now();
    const waits = new Map<number, string[]>();
    const failing: string[] = [];
    for (const id of ids) {
      const at = holdUntil(why, this.deps.store.holds(id), now);
      if (at === undefined) failing.push(id);
      else waits.set(at, [...(waits.get(at) ?? []), id]);
    }
    for (const [at, group] of waits) {
      const held = this.deps.store.moveInbound(group, "hold", undefined, at);
      if (held.length > 0) this.deps.onSettled?.(held, "waiting", { ...why, retryAt: at });
    }
    // Quota waits are logged where the hold begins (block); these are the passing failures
    // that have no other trace in the log until the retry.
    if (why.failure !== "quota") {
      const held = [...waits.values()].reduce((n, group) => n + group.length, 0);
      if (held > 0) this.deps.log?.(`${this.agentId}: ${held} message(s) waiting to retry (${why.failure})`);
    }
    // A usage limit holds for everything after it too, until the reset. Mingle's account ledger
    // decides the shared deadline; without a ledger this runtime still gates itself.
    if (why.failure === "quota" && waits.size > 0) {
      const top = Math.max(...waits.keys());
      if (this.deps.onLimit) this.deps.onLimit(this.sessionSignIn, top, why);
      else this.block(top, why);
    }
    const failed = this.deps.store.moveInbound(failing, "fail");
    if (failed.length > 0) this.deps.onSettled?.(failed, "failed", why);
  }

  /**
   * Hold `batch` for the wait in force: its messages go to `waiting` until `blocked.until`, and
   * its reminders and notes go back to pending rather than being delivered into a refusal.
   */
  private holdBatch(batch: readonly Pending[]): boolean {
    if (!this.blocked) return false;
    const { until, why } = this.blocked;
    const held = this.deps.store.moveInbound(
      batch.flatMap((p) => (p.kind === "message" ? [p.id] : [])),
      "hold",
      undefined,
      until,
    );
    if (held.length > 0) this.deps.onSettled?.(held, "waiting", { ...why, retryAt: until });
    this.pending.unshift(...batch.filter((p) => p.kind === "text"));
    return true;
  }

  /** The usage-limit wait in force, if any, for agents added later on the same sign-in. */
  get limit(): { until: number; why: FailureInfo } | undefined {
    return this.blocked && this.blocked.until > Date.now()
      ? { until: this.blocked.until, why: this.blocked.why }
      : undefined;
  }

  /**
   * Mingle's account ledger says this session's sign-in hit its usage limit: wait it out rather
   * than deliver only to fail the same way. A later wait already in place is kept.
   */
  holdFor(until: number, why: FailureInfo): void {
    if (this.disposed || until <= Date.now() || (this.blocked && this.blocked.until >= until)) return;
    this.block(until, why);
  }

  /**
   * The ledger wait on this session's sign-in ended: drop the local gate and deliver anything
   * pending. Waiting messages are Mingle's to deliver again.
   */
  release(): void {
    if (this.disposed) return;
    this.unblock();
    if (this.pending.length > 0) this.flushSoon();
  }

  private block(until: number, why: FailureInfo): void {
    this.unblock();
    this.blocked = { until, why };
    this.deps.log?.(
      `${this.agentId}: usage limit wait until ${new Date(until).toISOString()}${why.resetsAt ? ` (resets ${new Date(why.resetsAt).toISOString()})` : ""}`,
    );
    // The local gate opens locally at the deadline; the ledger entry survives it, so a turn that
    // succeeds after it can end the wait for every agent on the sign-in.
    this.unblockTimer = setTimeout(
      () => {
        this.unblock();
        if (this.pending.length > 0) this.flushSoon();
      },
      Math.max(0, until - Date.now()),
    );
    this.unblockTimer.unref?.();
  }

  private unblock(): void {
    clearTimeout(this.unblockTimer);
    this.unblockTimer = undefined;
    this.blocked = undefined;
  }

  private render(messageId: string): string {
    const { store } = this.deps;
    const message = store.message(messageId);
    const chat = message && store.chat(message.chatId);
    if (!message || !chat) return "";
    // In a group, how much was said there without the agent, so it can read back when it matters.
    const unseen = chat.kind === "dm" ? 0 : store.unseen(chat.id, message.createdAt);
    const text = renderMessage(store, message, { unseen });
    if (!text) return "";
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
    // The sign-in this session will run on, fixed before anything async: everything the session
    // reports later (quota waits, completed turns) is accounted under this key, never under
    // whatever the configuration changed to while the session lived. Reading the secret store
    // yields, so the configuration — sign-in AND the credentials themselves — is sampled again
    // each pass until a consistent pair survives a whole read; a stale snapshot is never given
    // to the harness. A disposed or replaced runtime stops here, before it can call onSession.
    const gen = this.generation;
    let agent: Agent;
    let key: string;
    let own: Readonly<Record<string, string>>;
    for (;;) {
      if (this.disposed || gen !== this.generation) throw new Error("agent runtime disposed");
      agent = this.agent();
      key = this.deps.signIn();
      // A harness whose shell gets no environment (Cursor) gets none of the agent's variables
      // either, and the guide does not name them. Values never go into the prompt.
      const reading = this.deps.harness.acceptsEnv?.(agent.harness) === false ? undefined : this.deps.agentEnv?.();
      own = reading ? await reading : {};
      if (this.disposed || gen !== this.generation) throw new Error("agent runtime disposed");
      if (key === this.deps.signIn()) break;
    }
    const changed = this.sessionSignIn !== key;
    this.sessionSignIn = key;
    this.deps.onSession(key, changed);
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
          if (this.disposed || gen !== this.generation) return;
          if (self && this.stopped) {
            // The stopped work coming back (a background command ended and woke the agent).
            this.deps.log?.(`${this.agentId}: aborted a turn the harness began after a stop`);
            void this.session?.abort().catch(() => {});
          }
          this.running = true;
          this.turnRevision = this.deps.limitRevision(key);
          this.setStatus("thinking");
          this.deps.onActivity?.("thinking");
        },
        onTurnEnded: (outcome) => {
          if (this.disposed || gen !== this.generation) return;
          this.running = false;
          if (outcome.kind === "failed") {
            const failure = outcome.failure ?? "unknown";
            this.deps.log?.(`${this.agentId}: turn failed (${failure}${outcome.reason ? `: ${outcome.reason}` : ""})`);
            this.setStatus("error", outcome.reason ?? "the turn failed", failure);
            // The agent did not get to answer: say so now rather than nudge it into the same failure.
            this.settleAwaiting({ failure, ...(outcome.resetsAt ? { resetsAt: outcome.resetsAt } : {}) });
          } else {
            this.setStatus("idle");
          }
          // The sign-in answered: any usage-limit wait on it is over, for every agent sharing it.
          if (outcome.kind === "completed") this.deps.onTurnCompleted?.(key, this.turnRevision);
          this.turnRevision = undefined;
          this.afterTurn(outcome.kind === "completed");
        },
        onActivity: (kind, detail) => {
          if (this.disposed || gen !== this.generation) return;
          this.setStatus(kind === "tool" ? "working" : "thinking", detail ?? null);
          this.deps.onActivity?.(kind, detail);
        },
      },
    );
    if (this.disposed || gen !== this.generation) {
      // Stopped or replaced while the open was in flight: drop it, don't keep it.
      await session.dispose();
      throw new Error("agent runtime disposed");
    }
    if (agent.sessionId && !session.resumed) {
      this.deps.log?.(`${this.agentId}: session ${agent.sessionId} was gone; opened ${session.id}`);
    } else {
      this.deps.log?.(`${this.agentId}: session ${session.id} ${session.resumed ? "resumed" : "opened"}`);
    }
    this.deps.store.setSessionId(this.agentId, session.id);
    this.session = session;
    return session;
  }

  /** After each turn: remind the agent once about messages it has not answered (docs/spec.md 4.3). */
  private afterTurn(completed = false): void {
    if (this.disposed) return;
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
    if (givenUp.length > 0) {
      this.deps.log?.(`${this.agentId}: gave up on ${givenUp.length} unanswered message(s)`);
      this.deps.onSettled?.(givenUp, "unanswered");
    }
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
    const last = this.deps.store.memoryHint(this.agentId);
    // Trimmed back under the limit: the hint has done its job, so growing past it again is news
    // and is told at once, not a day after the last hint.
    if (last && size <= MEMORY_LIMIT) {
      this.deps.store.setMemoryHint(this.agentId, null, null);
      return;
    }
    if (!memoryHintDue(size, last, now)) return;
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

  /** Every message still waiting on this agent's answer was lost to `why`. */
  private settleAwaiting(why: FailureInfo): void {
    this.settleLost(
      this.deps.store.awaitingReply(this.agentId).map((m) => m.id),
      why,
    );
  }

  private fail(error: unknown): void {
    if (this.disposed) return; // A stopped or deleted agent stays offline, not error.
    const message = error instanceof Error ? error.message : String(error);
    this.deps.log?.(`${this.agentId}: ${message}`);
    // Reopen (resuming the same conversation) on the next input.
    const session = this.session;
    this.generation++;
    this.session = undefined;
    this.running = false;
    void session?.dispose().catch(() => {});
    const failure = failureOf(error);
    this.setStatus("error", message, failure);
    this.settleAwaiting({ failure });
  }
}
