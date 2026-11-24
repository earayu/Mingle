import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { Harness, HarnessSession, TurnEnd } from "../harness/harness.ts";
import type { Agent, Store, Task } from "../store/store.ts";

/**
 * Several things at once (docs/spec.md 4.13). An agent's main session talks with people; work that
 * takes a while goes to a line: a session of the agent's own for that one task, beside the main
 * one. A line is the same agent, so it answers in the chat as the agent, about its task only.
 *
 * Sessions open for a turn and close when it ends: an idle line costs nothing, and the next
 * follow-up resumes the same conversation, or starts a new one with the brief when it cannot.
 */

/** Lines of one agent working at the same time; more wait their turn. */
export const MAX_LINES = 3;

export interface LineDeps {
  readonly store: Store;
  readonly harness: Harness;
  /** Where the line works: its own directory, outside the agent's home. */
  readonly dir: (agent: Agent, task: Task) => string;
  /** The guide the line's session opens with. */
  readonly manual: (agent: Agent, task: Task) => string;
  /** Mingle's variables for this line: its own token, scoped to the task. */
  readonly env: (agent: Agent, task: Task) => Record<string, string>;
  /** Global defaults passed below agent variables (e.g. network proxy). */
  readonly baseEnv?: () => Readonly<Record<string, string>>;
  /** The variables the owner set for the agent. */
  readonly agentEnv: (agentId: string) => Promise<Record<string, string>> | undefined;
  /** Told with the agent's next input: no turn of its own (like the owner's notes). */
  readonly note: (agentId: string, body: string) => void;
  /**
   * Follow-ups handed to the line and not answered yet. Kept in the store, so what was handed over
   * before a restart (or while the line waited for a free slot) still reaches it.
   */
  readonly unanswered: (task: Task) => { id: string; input: string }[];
  /**
   * The message the work is for, with what was said before it in that chat: the brief is written by
   * the main session, and the line should not have to go and find the conversation it came from.
   */
  readonly source?: (task: Task) => string;
  /**
   * The latest of what was said in the line's thread, for a line whose conversation could not be
   * resumed: the thread is the work's record, beyond the brief and the last summary.
   */
  readonly thread?: (task: Task) => string;
  readonly paused: (agentId: string) => boolean;
  readonly log?: (line: string) => void;
  /**
   * How long a line whose background work ended waits for the turn the harness begins on its own
   * before it closes the session. Default `SETTLE_MS`.
   */
  readonly settleMs?: number;
}

/**
 * A turn ended while commands the line started in the background still run (Claude Code refuses a
 * long foreground `sleep` and the model backgrounds it): the session stays open, or closing it would
 * kill them and the line would never answer. When they end, the harness begins a turn of its own;
 * if none begins within this long, the line closes as after any turn.
 */
export const SETTLE_MS = 15_000;

interface Line {
  readonly taskId: string;
  readonly agentId: string;
  /** Inputs waiting for the line's next turn. */
  pending: string[];
  /**
   * Messages steered into the turn under way. One that lands as the turn ends can be taken and
   * never acted on; if it is still unanswered when the turn ends, it goes in again as the next.
   */
  steered: Map<string, string>;
  /** Messages already in `pending`, so a recovered follow-up is not handed over twice. */
  pendingIds: Set<string>;
  /**
   * Not run since Mingle (re)started or the agent came back: its next turn picks up the follow-ups
   * the store says are still unanswered, which the memory of the previous run took with it.
   */
  recovering: boolean;
  session?: HarnessSession | undefined;
  /** A turn is under way, or its session is opening. */
  active: boolean;
  /** Bumped whenever the line is let go, so a late event of an old session changes nothing. */
  generation: number;
  /** A turn of its session is under way, prompted or begun by the harness itself. */
  turning: boolean;
  /** Checks on background work after a turn ended with some still running. */
  watch?: ReturnType<typeof setInterval> | undefined;
}

export class Lines {
  private readonly lines = new Map<string, Line>();
  private readonly deps: LineDeps;
  private stopping = false;

  constructor(deps: LineDeps) {
    this.deps = deps;
  }

  /** Work that was under way when Mingle stopped, or when the agent was paused, goes on. */
  restore(agentId?: string): void {
    for (const task of this.deps.store.activeLines(agentId)) {
      if (this.deps.paused(task.agentId)) continue;
      if (task.lineState === "running") {
        this.wake(
          task.id,
          "[mingle] Your work on this task was interrupted (Mingle restarted, or the owner paused and resumed you). Continue where you left off.",
        );
      } else this.schedule(task.agentId);
    }
  }

  /** Start a new task's line, now or once a line is free. */
  start(task: Task): void {
    this.line(task).pending.push(this.brief(task));
    this.schedule(task.agentId);
  }

  /** Hand the line something (`messageId`: the message it is): into the turn under way, or as its next. */
  wake(taskId: string, input: string, messageId?: string): void {
    const task = this.deps.store.taskById(taskId);
    if (!task || task.lineState === "ended") return;
    const line = this.line(task);
    if (line.active && line.session) {
      if (messageId) line.steered.set(messageId, input);
      const session = line.session;
      // Refused (the turn just ended, say): it waits for the line's next turn instead.
      const later = () => {
        if (messageId) line.steered.delete(messageId);
        if (line.session === session && line.active) {
          if (messageId) {
            if (line.pendingIds.has(messageId)) return;
            line.pendingIds.add(messageId);
          }
          line.pending.push(input);
          return;
        }
        this.wake(taskId, input, messageId);
      };
      void session.deliver(input, randomUUID()).then((r) => r.outcome === "rejected" && later(), later);
      return;
    }
    if (messageId) {
      if (line.pendingIds.has(messageId)) return;
      line.pendingIds.add(messageId);
    }
    line.pending.push(input);
    if (task.lineState !== "running") this.deps.store.updateLine(task.id, { lineState: "queued" });
    this.schedule(task.agentId);
  }

  /** How many lines of this agent are working or waiting for a free line. */
  busy(agentId: string): number {
    return this.deps.store.activeLines(agentId).length;
  }

  /** The owner stopped one task: its line ends for good. */
  async end(taskId: string): Promise<void> {
    const line = this.lines.get(taskId);
    this.lines.delete(taskId);
    this.deps.store.updateLine(taskId, { lineState: "ended" });
    if (line) await this.letGo(line, true);
    const task = this.deps.store.taskById(taskId);
    if (task) this.schedule(task.agentId);
  }

  /**
   * The line closed its own task, from inside its turn (someone told it to stop): it ends for good
   * once this turn is over, without cutting off the command that closed it.
   */
  release(taskId: string): void {
    this.deps.store.updateLine(taskId, { lineState: "ended" });
    const line = this.lines.get(taskId);
    if (!line) return;
    line.pending = [];
    line.pendingIds.clear();
    line.steered.clear();
    if (!line.active) {
      this.lines.delete(taskId);
      void this.letGo(line, false);
    }
  }

  /**
   * `/stop`: every line of the agent stops its turn and waits; the next message handed to it wakes
   * it. Queued ones stay queued.
   */
  async stopAll(agentId: string): Promise<boolean> {
    let stopped = false;
    for (const line of [...this.lines.values()].filter((l) => l.agentId === agentId)) {
      if (!line.active) continue;
      stopped = true;
      line.pending = [];
      line.pendingIds.clear();
      const gen = await this.letGo(line, true);
      if (line.generation === gen && this.deps.store.taskById(line.taskId)?.lineState !== "ended") {
        this.deps.store.updateLine(line.taskId, { lineState: "idle" });
      }
    }
    return stopped;
  }

  /** Paused or deleted: close the sessions, keep where each line stood for when it comes back. */
  async suspend(agentId: string): Promise<void> {
    for (const line of [...this.lines.values()].filter((l) => l.agentId === agentId)) {
      this.lines.delete(line.taskId);
      await this.letGo(line, true);
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.lines.values()].map((line) => this.letGo(line, false)));
    this.lines.clear();
  }

  private line(task: Task): Line {
    let line = this.lines.get(task.id);
    if (!line) {
      line = {
        taskId: task.id,
        agentId: task.agentId,
        pending: [],
        steered: new Map(),
        pendingIds: new Set(),
        recovering: true,
        active: false,
        generation: 0,
        turning: false,
      };
      this.lines.set(task.id, line);
    }
    return line;
  }

  /** The brief a line starts from: the task, the message it came from, and what is asked. */
  private brief(task: Task, previous?: string, again = false): string {
    const parts = [
      `[task=${task.id} from=${task.fromMessage ?? "-"} chat=${task.fromChat ?? "-"}] ${task.title}`,
      task.brief ?? "",
      this.deps.source?.(task) ?? "",
    ];
    if (task.summary) parts.push(`What you reported last time:\n${task.summary}`);
    if (again) parts.push(this.deps.thread?.(task) ?? "");
    if (previous) parts.push(previous);
    return parts.filter(Boolean).join("\n\n");
  }

  /** Start the lines that have something to do, while there is room. */
  private schedule(agentId: string): void {
    if (this.stopping || this.deps.paused(agentId)) return;
    const working = () => [...this.lines.values()].filter((l) => l.agentId === agentId && l.active).length;
    const waiting = this.deps.store
      .activeLines(agentId)
      .map((task) => ({ task, line: this.line(task) }))
      .filter(({ line }) => !line.active);
    for (const { task, line } of waiting) {
      if (working() >= MAX_LINES) break;
      // Queued since a restart with nothing in hand: it starts from its brief again.
      if (!line.pending.length) line.pending.push(this.brief(task));
      void this.run(line);
    }
  }

  private async run(line: Line): Promise<void> {
    const { store } = this.deps;
    const task = store.taskById(line.taskId);
    const agent = task && store.agent(task.agentId);
    if (!task || !agent) {
      this.lines.delete(line.taskId);
      return;
    }
    line.active = true;
    const gen = ++line.generation;
    store.updateLine(task.id, { lineState: "running", lineError: null });
    let session: HarnessSession;
    try {
      session = await this.open(line, agent, task, gen);
    } catch (error) {
      if (gen !== line.generation) return;
      this.failed(line, task, (error as Error).message);
      return;
    }
    if (gen !== line.generation) {
      await session.dispose().catch(() => {});
      return;
    }
    line.session = session;
    if (task.sessionId !== session.id) store.updateLine(task.id, { sessionId: session.id });
    if (line.recovering) {
      line.recovering = false;
      for (const { id, input } of this.deps.unanswered(task)) {
        if (!line.pendingIds.has(id)) line.pending.push(input);
      }
    }
    // A new conversation instead of the old one: it starts from the brief, not from nothing.
    const fresh = Boolean(task.sessionId) && !session.resumed;
    const input = line.pending.join("\n\n");
    line.pending = [];
    line.pendingIds.clear();
    const text = fresh ? this.brief(task, input, true) : input;
    const result = await session.deliver(text, randomUUID()).catch((error: Error) => ({
      outcome: "rejected" as const,
      reason: error.message,
    }));
    if (result.outcome === "rejected" && gen === line.generation) {
      this.failed(line, task, result.reason ?? "the harness refused the input");
    }
  }

  private async open(line: Line, agent: Agent, task: Task, gen: number): Promise<HarnessSession> {
    const dir = this.deps.dir(agent, task);
    mkdirSync(dir, { recursive: true });
    const own = (await this.deps.agentEnv(agent.id)) ?? {};
    const options = {
      harness: agent.harness,
      model: agent.model,
      cwd: dir,
      appendSystemPrompt: this.deps.manual(agent, task),
      env: { ...this.deps.baseEnv?.(), ...own, ...this.deps.env(agent, task) },
    };
    const events = {
      onTurnStarted: () => {
        if (gen !== line.generation) return;
        line.turning = true;
        this.unwatch(line);
      },
      onActivity: () => {},
      onTurnEnded: (outcome: TurnEnd) => {
        if (gen !== line.generation) return;
        line.turning = false;
        void this.ended(line, outcome);
      },
    };
    try {
      return await this.deps.harness.open({ ...options, resume: task.sessionId }, events);
    } catch (error) {
      // The old conversation would not open: a new one, which starts from the brief.
      if (!task.sessionId) throw error;
      this.deps.log?.(`line ${task.id}: could not resume (${(error as Error).message}); starting over`);
      // `resumed` is false on it, so the brief goes with the input.
      return await this.deps.harness.open({ ...options, resume: null }, events);
    }
  }

  /** A turn ended: the next input goes in, or the session closes until the next follow-up. */
  private async ended(line: Line, outcome: TurnEnd): Promise<void> {
    const { store } = this.deps;
    const task = store.taskById(line.taskId);
    if (!task) return;
    // It closed its own task in this turn: nothing more to do, ever.
    if (task.lineState === "ended") {
      this.lines.delete(line.taskId);
      await this.letGo(line, false);
      this.schedule(line.agentId);
      return;
    }
    if (outcome.kind === "failed") {
      this.failed(line, task, outcome.reason ?? outcome.failure ?? "the turn failed");
      return;
    }
    // What came in during the turn and is still unanswered: it may never have been seen.
    for (const [id, input] of line.steered) {
      if (store.message(id)?.state === "delivered") line.pending.push(input);
    }
    line.steered.clear();
    if (line.pending.length && line.session) {
      const input = line.pending.join("\n\n");
      line.pending = [];
      line.pendingIds.clear();
      const gen = line.generation;
      const result = await line.session.deliver(input, randomUUID()).catch((error: Error) => ({
        outcome: "rejected" as const,
        reason: error.message,
      }));
      // Refused: the line would wait for a turn that never comes. It stops with an error, which the
      // main session hears about, and the next follow-up starts it again.
      if (result.outcome === "rejected" && gen === line.generation) {
        this.failed(line, task, result.reason ?? "the harness refused the input");
      }
      return;
    }
    // Still working in the background: the harness wakes the session when that work ends.
    if (task.status === "in_progress" && (line.session?.background?.() ?? 0) > 0) {
      this.watch(line);
      return;
    }
    await this.rest(line);
  }

  /** Nothing more to do for now: the session closes until the next follow-up. */
  private async rest(line: Line): Promise<void> {
    const gen = await this.letGo(line, false);
    if (line.generation === gen && this.deps.store.taskById(line.taskId)?.lineState === "running") {
      this.deps.store.updateLine(line.taskId, { lineState: "idle" });
    }
    this.schedule(line.agentId);
  }

  /**
   * Keep the session open while its background work runs. Once none runs and no turn has begun for
   * `settleMs`, rest.
   */
  private watch(line: Line): void {
    this.unwatch(line);
    const settle = this.deps.settleMs ?? SETTLE_MS;
    const every = Math.max(10, Math.min(1000, settle / 3));
    const gen = line.generation;
    let quietSince: number | undefined;
    line.watch = setInterval(() => {
      if (gen !== line.generation || line.turning || !line.session) return this.unwatch(line);
      if ((line.session.background?.() ?? 0) > 0) {
        quietSince = undefined;
        return;
      }
      quietSince ??= Date.now();
      if (Date.now() - quietSince < settle) return;
      this.unwatch(line);
      this.deps.log?.(`line ${line.taskId}: background work ended without starting a new turn; resting`);
      void this.rest(line);
    }, every);
    line.watch.unref?.();
  }

  private unwatch(line: Line): void {
    clearInterval(line.watch);
    line.watch = undefined;
  }

  private failed(line: Line, task: Task, why: string): void {
    this.deps.log?.(`line ${task.id}: ${why}`);
    this.deps.store.updateLine(task.id, { lineState: "error", lineError: why.slice(0, 300) });
    this.deps.note(
      task.agentId,
      `[mingle] The work on task ${task.id} ("${task.title}") stopped with an error: ${why.slice(0, 300)}. Tell the person who asked, or start it again with task run.`,
    );
    void this.letGo(line, false).then(() => this.schedule(task.agentId));
  }

  private async letGo(line: Line, abort: boolean): Promise<number> {
    const gen = ++line.generation;
    line.active = false;
    line.turning = false;
    line.steered.clear();
    this.unwatch(line);
    const session = line.session;
    line.session = undefined;
    if (!session) return gen;
    if (abort) await session.abort().catch(() => false);
    await session.dispose().catch(() => {});
    return gen;
  }
}
