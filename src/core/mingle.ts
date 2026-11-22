import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import { join } from "node:path";
import type {
  Channel,
  ChannelConnection,
  ChatRef,
  ConnectionState,
  Credentials,
  InboundMessage,
  OnboardingEvent,
  OnboardingFailure,
  PermissionId,
  Platform,
} from "../channels/channel.ts";
import { LOCAL_OWNER, type LocalChannel, type LocalFile, localChannel } from "../channels/local/local.ts";
import type { Harness, HarnessInfo, HarnessStatus } from "../harness/harness.ts";
import { checkEnvironment, runCommand } from "../platform/command.ts";
import type { SecretStore } from "../platform/secrets.ts";
import {
  type Agent,
  type Chat,
  type Connection,
  type Contact,
  contactName,
  type Handoff,
  type HearPace,
  type Message,
  type Reminder,
  Store,
  type Task,
  type TaskStatus,
} from "../store/store.ts";
import { VERSION } from "../version.ts";
import { CLAIM_ATTEMPTS, CLAIM_TTL_MS, claimAttempt, claimCode, gate } from "./access.ts";
import { Brains } from "./brains.ts";
import {
  CHECK_FAILURES_TOLD,
  CHECK_MAX_OUTPUT,
  CHECK_TIMEOUT_MS,
  type CheckOutcome,
  changedText,
  expiredText,
  failingText,
  outcome,
} from "./check.ts";
import { coldRebuildFor } from "./cold.ts";
import { diagnosisPrompt } from "./diagnose.ts";
import { checkEnvName, checkEnvValue, decodeEnvValue, encodeEnvValue, envRef } from "./env.ts";
import { MingleError, notFound } from "./errors.ts";
import { formatHeard, formatReminder, formatUnmuted, renderMessage } from "./format.ts";
import { checkHandoff, handoffPrompt } from "./handoff.ts";
import {
  cueIn,
  defaultTier,
  type Engage,
  HEAR_GAP_MS,
  HEAR_MAX_WAIT_MS,
  HEAR_QUIET_MS,
  HearingBook,
  type HearTier,
  nameIn,
  type Stretch,
} from "./hearing.ts";
import { createHome, memorySize, readRole, writeRole } from "./home.ts";
import { slugify } from "./ids.ts";
import { Lines } from "./lines.ts";
import { BACKOFF_MS, type LinkEffect, type LinkEvent, type LinkState, step, stored } from "./link.ts";
import { accessText, botBrakeNote, LiveReplies, pausedNote, stopNote } from "./live.ts";
import { renderManual } from "./manual.ts";
import { Outbox, type SendReport } from "./outbox.ts";
import type { Paths } from "./paths.ts";
import { Remotes, type RemoteTransport } from "./remotes.ts";
import { AgentRuntime, type FailureInfo, type TextTrack } from "./runtime.ts";
import { nextFire } from "./schedule.ts";
import { BotHops, trigger } from "./trigger.ts";

/** Messages before the one a line works for that its brief carries (docs/spec.md 4.13). */
const LINE_SOURCE_BEFORE = 10;
/** How much of its thread a line reads when its old conversation could not be resumed (docs/spec.md 4.13). */
const LINE_THREAD_RECENT = 30;
export interface OnboardingSession {
  readonly id: string;
  readonly agentId: string;
  readonly platform: Platform;
  state:
    | { kind: "starting" }
    | { kind: "qr"; content: string; expiresAt: number }
    | { kind: "scanned" }
    | { kind: "device"; userCode: string; url: string; expiresAt: number }
    | { kind: "awaiting_approval" }
    | { kind: "needs_code"; retry: boolean }
    | { kind: "done"; connectionId: string; pendingApproval: boolean; bot: string | null }
    | { kind: "failed"; code: string };
  readonly abort: AbortController;
  updatedAt: number;
  /** Set while the platform waits for a code typed in the console. */
  submitCode?: ((code: string) => void) | undefined;
}

function onboardingError(platform: Platform, code: OnboardingFailure): MingleError {
  return new MingleError(
    `onboarding_${code}`,
    code === "invalid_credentials" ? `${platform} did not accept these credentials` : "try again",
  );
}

interface Link {
  state: LinkState;
  /** Which connect attempt is current; bumped by every new attempt and by removal. */
  gen: number;
  timer?: NodeJS.Timeout | undefined;
}

/** Largest file the owner can attach in the private chat (docs/spec.md 6.9). */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** A file the owner attached in the private chat, kept until it is sent. */
export interface LocalUpload {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly mime?: string;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};

/** A file's type by its extension, where it is a common one. */
export function mimeOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? MIME[name.slice(dot + 1).toLowerCase()] : undefined;
}

export interface MingleOptions {
  readonly remoteTransport?: RemoteTransport;
  readonly paths: Paths;
  readonly harness: Harness;
  readonly channels: Partial<Record<Platform, Channel>>;
  readonly secrets: SecretStore;
  /** Absolute path of the CLI entry script, run with this Node binary. */
  readonly cliEntry: string;
  readonly coalesceMs?: number;
  /** See `RuntimeDeps.emptyTurnWaitMs`. */
  readonly emptyTurnWaitMs?: number;
  /** See `LineDeps.settleMs`. */
  readonly lineSettleMs?: number;
  /** See `RuntimeDeps.stallMs`. */
  readonly stallMs?: number;
  /** Which agents open a fresh session on a cold start (`cold.ts`); the value of `MINGLE_COLD_START`. */
  readonly coldStart?: string;
  readonly reminderTickMs?: number;
  /** How often to look for a jump of the clock, the sign that the computer slept. */
  readonly wakeCheckMs?: number;
  readonly retryDelaysMs?: readonly number[];
  /** Waits between automatic reconnect attempts of a bot that went offline. */
  readonly reconnectDelaysMs?: readonly number[];
  /** How a group that hears everything paces what it hands the agent; the `HEAR_*` defaults otherwise. */
  readonly hearing?: { readonly quietMs: number; readonly maxWaitMs: number; readonly gapMs: number };
  /** Engagement in a group that hears everything (docs/spec.md 4.2); `ENGAGE` from hearing.ts otherwise. */
  readonly engage?: Partial<Engage>;
  readonly log?: (line: string) => void;
}

/** Variables that give an agent a sign-in of its own, so it does not share the computer's usage limit. */
/** How long a group's member list stays fresh before an active group is read again. */
const ROSTER_TTL_MS = 6 * 60 * 60_000;

export {
  HEAR_BACKOFF_AFTER,
  HEAR_BACKOFF_MAX_MS,
  HEAR_GAP_MS,
  HEAR_MAX_WAIT_MS,
  HEAR_QUIET_MS,
} from "./hearing.ts";

/** Messages a heard stretch hands over at most; the rest is a `message read` away (docs/spec.md 4.2). */
const HEAR_MESSAGES = 30;
/** How long a group's count of active people (its default tier) is kept before it is counted again. */
const ACTIVE_TTL_MS = 60 * 60_000;
const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** The gaps an agent may set for a group itself: no more often than Mingle's own pace, at most a week. */
export const HEAR_EVERY_MIN_MS = HEAR_GAP_MS;
export const HEAR_EVERY_MAX_MS = 7 * 24 * 60 * 60_000;

/** A group's pace as the owner and the agent see it: what was set, and the gap in force now. */
export interface HearingView {
  readonly pace: "auto" | "every" | "muted";
  /** `every`: the gap the agent set. */
  readonly everyMs?: number;
  /** `auto` while unanswered stretches have lengthened the gap: the gap now. */
  readonly slowedMs?: number;
  /** How fast it keeps up with a conversation, as the owner chose; null follows the group's size. */
  readonly tier: HearTier | null;
  /** The tier the group's size gives it. */
  readonly defaultTier: HearTier;
  /** `auto`: the people it is in a conversation with now, by name, most engaged first. */
  readonly live: string[];
  /** Other names that count as calling it there. */
  readonly aliases: string[];
}

/** What else a group may call the agent (docs/spec.md 4.2): a few short names, so a word cannot become a trigger for everything. */
export const ALIAS_MAX = 8;
export const ALIAS_CHARS = { min: 2, max: 16 } as const;

/** Aliases as stored: trimmed, each once (ignoring case), the agent's own names left out. */
export function cleanAliases(list: readonly string[], own: readonly (string | null | undefined)[]): string[] {
  const taken = new Set(own.flatMap((n) => (n ? [n.trim().toLowerCase()] : [])));
  const out: string[] = [];
  for (const raw of list) {
    const alias = raw.trim().replace(/\s+/g, " ");
    const chars = [...alias].length;
    if (chars < ALIAS_CHARS.min || chars > ALIAS_CHARS.max) {
      throw new MingleError(
        "alias_invalid",
        `give a name of ${ALIAS_CHARS.min} to ${ALIAS_CHARS.max} characters, the way people in the group call you`,
      );
    }
    const key = alias.toLowerCase();
    if (taken.has(key)) continue;
    taken.add(key);
    out.push(alias);
  }
  if (out.length > ALIAS_MAX) {
    throw new MingleError("too_many_aliases", `a group can have at most ${ALIAS_MAX} names; remove one first`);
  }
  return out;
}

const OWN_SIGN_IN = /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BASE_URL|CONFIG_DIR|_HOME)$/;

/** The whole local process: store, agent runtimes, live IM connections, reminders. The HTTP API sits on top. */
export class Mingle {
  readonly remotes: Remotes;
  readonly store: Store;
  readonly outbox: Outbox;
  private readonly replies: LiveReplies;
  readonly adminToken = randomBytes(24).toString("base64url");
  private apiUrl = "";
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly live = new Map<string, ChannelConnection>();
  /** Each bot's place in its connection state machine (`link.ts`). */
  private readonly links = new Map<string, Link>();
  private readonly tokens = new Map<string, string>();
  /** CLI tokens of lines: each speaks for its agent, about its task only (docs/spec.md 4.13). */
  private readonly lineTokens = new Map<string, { agentId: string; taskId: string }>();
  /** The agents' lines: tasks worked on in sessions of their own. */
  readonly lines: Lines;
  private reminderTimer: NodeJS.Timeout | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private resuming: Promise<void> | undefined;
  private readonly onboardings = new Map<string, OnboardingSession>();
  /** Paused agents (docs/spec.md 4.11), and the chats already told so during the current pause. */
  private readonly paused = new Set<string>();
  private readonly pauseNoted = new Set<string>();
  /** When each group's member list was last read into the address book (docs/spec.md 4.2). */
  private readonly rostered = new Map<string, number>();
  /** Contacts whose profile was read this run, and the queue the reads go through. */
  private readonly profiled = new Set<string>();
  private profiling: Promise<void> = Promise.resolve();
  /** Wrong claim codes each ownerless bot took since its code was issued (docs/spec.md 4.7). */
  private readonly claimMisses = new Map<string, number>();
  /** Turns other bots started in each chat since a person last spoke there (docs/spec.md 4.2). */
  private readonly botHops = new BotHops();
  /**
   * Chats that hear everything with a stretch waiting to reach the agent: the timer that hands it
   * over. What the stretch holds and when it is due is in `book`. In memory: after a restart the
   * next message starts anew.
   */
  private readonly hearing = new Map<string, { agentId: string; timer: NodeJS.Timeout }>();
  /** The pace of every group that hears everything (docs/spec.md 4.2). */
  private readonly book: HearingBook;
  /** Up to when the agent's own messages in each chat have been told to `book`. */
  private readonly spokeSynced = new Map<string, number>();
  /** Each group's count of people active in the last week, for its default tier, and when it was counted. */
  private readonly active = new Map<string, { n: number; at: number }>();
  /** Sessions of just-paused agents that are still closing; resuming waits for them. */
  private readonly closing = new Map<string, Promise<void>>();
  /**
   * Usage limits by sign-in (docs/spec.md 4.3): the account-wide wait each session reports
   * against. `revision` distinguishes reports, so a turn that began under an older wait cannot
   * clear a newer one.
   */
  private readonly limits = new Map<string, { until: number; why: FailureInfo; revision: number }>();
  private limitRevision = 0;
  /** How many times each agent's own sign-in was re-scoped by credential or harness changes. */
  private readonly signInVersions = new Map<string, number>();
  /** Installs and sign-ins of harnesses, run for the console. */
  readonly brains: Brains;
  /**
   * Check commands while they run (docs/spec.md 4.6): one per reminder, keyed by reminder id, and
   * the one-shot runs `reminder set --check` does first, keyed `probe:<agent>:<n>`. Each carries
   * its AbortController so a cancel, pause, delete or shutdown can end the command in place.
   */
  private readonly checking = new Map<string, { agentId: string; controller: AbortController; run: Promise<void> }>();
  private probeSeq = 0;
  /** Set once stop() begins: nothing new starts, and what runs is aborted and drained. */
  private stopping = false;
  /** Agents being deleted: like `stopping` for one agent, for the window before its rows are gone. */
  private readonly deleting = new Set<string>();

  readonly options: MingleOptions;
  /** The owner's private chat in the console (docs/spec.md 6.9): one connection per agent, built in. */
  readonly localChat: LocalChannel = localChannel();
  /** The chat apps, and the built-in private chat. */
  private readonly channels: Partial<Record<Platform, Channel>>;

  constructor(options: MingleOptions) {
    this.options = options;
    this.channels = { ...options.channels, local: this.localChat };
    this.book = new HearingBook(() => this.pace(), options.engage);
    this.remotes = new Remotes(options.paths.home, options.remoteTransport);
    for (const dir of [
      options.paths.home,
      options.paths.agents,
      options.paths.avatars,
      options.paths.bin,
      options.paths.logs,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    this.store = new Store(options.paths.db);
    this.replies = new LiveReplies((line) => this.log(line));
    this.outbox = new Outbox(
      this.store,
      (id) => this.live.get(id),
      options.retryDelaysMs,
      this.replies,
      (agentId, messageId) => this.runtimes.get(agentId)?.isQueued(messageId) ?? false,
    );
    this.lines = new Lines({
      store: this.store,
      harness: options.harness,
      dir: (agent, task) => join(options.paths.home, "lines", agent.slug, task.id),
      manual: (agent, task) =>
        renderManual(
          agent.name,
          readRole(this.homeDir(agent)),
          process.platform,
          options.harness.acceptsEnv?.(agent.harness) === false ? [] : this.store.envNames(agent.id).map((v) => v.name),
          { taskId: task.id, title: task.title, home: this.homeDir(agent) },
        ),
      env: (agent, task) => ({
        MINGLE_API: this.apiUrl,
        MINGLE_TOKEN: this.lineToken(agent.id, task.id),
        MINGLE_CLI: this.cliPath,
      }),
      agentEnv: (id) => this.agentEnv(id),
      ...(options.lineSettleMs !== undefined ? { settleMs: options.lineSettleMs } : {}),
      note: (id, body) => this.store.addOwnerNote(id, body),
      unanswered: (task) => {
        const agent = this.store.agent(task.agentId);
        return this.store
          .lineInbox(task.id)
          .map((m) => ({ id: m.id, input: renderMessage(this.store, m, { agentName: agent?.name ?? "" }) }));
      },
      source: (task) => this.lineSource(task),
      thread: (task) => this.lineThread(task),
      paused: (id) => this.paused.has(id) || this.deleting.has(id),
      log: (line) => this.log(line),
    });
    // A new install or sign-in can change which harnesses are usable and which models they offer.
    this.brains = new Brains(options.harness, () => {
      this.modelCache.clear();
      // Drop the answers and any probe that started before the change, so none of it is kept.
      this.harnessList = undefined;
      this.harnessProbe = undefined;
      this.catalogList = undefined;
      this.catalogProbe = undefined;
    });
  }

  get cliPath(): string {
    // Windows runs a .cmd by name; elsewhere a shell script.
    return join(this.options.paths.bin, process.platform === "win32" ? "mingle.cmd" : "mingle");
  }

  /** Start everything. `apiUrl` is where the HTTP API listens; agents' CLI calls go there. */
  async start(apiUrl: string): Promise<void> {
    this.apiUrl = apiUrl;
    this.writeCliWrapper();
    // Warm the harness list and the catalog so the console's first look at either does not
    // wait on the probe. One after the other: each starts every harness's executable.
    void this.probeHarnesses()
      .catch((error) => this.log(`harness probe failed: ${(error as Error).message}`))
      .then(() => this.probeCatalog())
      .catch((error) => this.log(`harness catalog probe failed: ${(error as Error).message}`));
    // Account-level quota waits survive a restart (docs/spec.md 4.3): rebuild the ledger before
    // any session opens — one entry per sign-in, keeping the latest deadline its agents persisted.
    // Nothing is written until the whole scan settled on each sign-in's entry.
    {
      const expired: string[] = [];
      const maxima = new Map<string, { until: number; resetsAt: number | null }>();
      for (const agent of this.store.agents()) {
        const wait = this.store.quotaWait(agent.id);
        if (!wait) continue;
        if (wait.until <= Date.now()) {
          expired.push(agent.id);
          continue;
        }
        const key = this.signIn(agent.id);
        const prev = maxima.get(key);
        if (!prev || wait.until > prev.until) maxima.set(key, wait);
      }
      for (const id of expired) this.store.setQuotaWait(id);
      for (const [key, wait] of maxima) {
        this.limits.set(key, {
          until: wait.until,
          why: { failure: "quota", ...(wait.resetsAt != null ? { resetsAt: wait.resetsAt } : {}) },
          revision: ++this.limitRevision,
        });
      }
      for (const agent of this.store.agents()) this.saveLimitFor(agent.id);
    }
    // Every agent has its private chat in the console, agents made before it came too.
    for (const agent of this.store.agents()) this.ensureLocalChat(agent.id);
    for (const agent of this.store.agents()) {
      // A paused agent stays paused across restarts: no session, no token, until the owner resumes it.
      if (agent.status === "paused") this.paused.add(agent.id);
      else this.addRuntime(agent).start();
    }
    // Lines that were working when Mingle stopped carry on.
    this.lines.restore();
    await Promise.all(
      this.store
        .connections()
        .map((c) =>
          this.reconnect(c.id).catch((error) =>
            this.log(`connection ${c.id} could not be restored at start: ${(error as Error).message}`),
          ),
        ),
    );
    const tick = this.options.reminderTickMs ?? 10_000;
    this.reminderTimer = setInterval(() => {
      // One bad reminder or a store hiccup must not kill the tick, or the ones after it.
      try {
        this.fireReminders();
      } catch (error) {
        this.log(`reminder tick failed: ${(error as Error).message}`);
      }
      try {
        this.resumeWaiting();
      } catch (error) {
        this.log(`waiting-messages tick failed: ${(error as Error).message}`);
      }
      try {
        this.tidyMemories();
      } catch (error) {
        this.log(`memory tidy-up tick failed: ${(error as Error).message}`);
      }
    }, tick);
    // Timers do not run while the computer sleeps: a tick that comes far later than due means it
    // slept, and its connections are likely dead without knowing it yet (docs/spec.md 7.1).
    const every = this.options.wakeCheckMs ?? 15_000;
    let last = Date.now();
    this.wakeTimer = setInterval(() => {
      const now = Date.now();
      const slept = now - last - every;
      last = now;
      if (slept > 60_000)
        void this.resume(`the computer slept for ${Math.round(slept / 60_000)} min`).catch((error) =>
          this.log(`resume after sleep failed: ${(error as Error).message}`),
        );
    }, every);
  }

  /**
   * Reconnect every chat app now, rather than waiting for each connection's heartbeat to notice
   * that it died during sleep, then fire the reminders that came due meanwhile.
   */
  resume(reason: string): Promise<void> {
    this.resuming ??= (async () => {
      this.log(`${reason}: reconnecting the chat apps`);
      await Promise.all(this.store.connections().map((connection) => this.reconnect(connection.id)));
      this.fireReminders();
      this.resumeWaiting();
    })().finally(() => {
      this.resuming = undefined;
    });
    return this.resuming;
  }

  /**
   * Stop means stop: mark it at once so nothing new starts, and let every running check command
   * go. Idempotent; the CLI calls it before closing the server so checks begin dying immediately,
   * then stop() drains what is left.
   */
  beginShutdown(): void {
    this.stopping = true;
    for (const op of this.checking.values()) op.controller.abort();
    // Stretches waiting to be heard go with it: their timers must not outlive the store.
    for (const chatId of this.hearing.keys()) this.unhear(chatId);
  }

  async stop(): Promise<void> {
    this.beginShutdown();
    // Disconnect management only. Remote daemons keep serving their chat apps.
    this.remotes.close();
    clearInterval(this.reminderTimer);
    clearInterval(this.wakeTimer);
    await this.resuming?.catch(() => {});
    await Promise.all(this.closing.values());
    this.brains.dispose();
    this.replies.dispose();
    for (const id of [...this.onboardings.keys()]) this.cancelOnboarding(id);
    for (const link of this.links.values()) {
      clearTimeout(link.timer);
      link.gen++;
    }
    this.links.clear();
    await Promise.all([...this.live.values()].map((c) => c.close().catch(() => {})));
    this.live.clear();
    await Promise.all([...this.runtimes.values()].map((r) => r.dispose()));
    this.runtimes.clear();
    await this.lines.close();
    await this.checksSettled();
    this.store.close();
  }

  log(line: string): void {
    this.options.log?.(line);
  }

  // ------------------------------------------------------------------ agents

  homeDir(agent: Pick<Agent, "slug">): string {
    return join(this.options.paths.agents, agent.slug);
  }

  /**
   * The installed harnesses. Finding them starts every harness's executable, over a second in
   * all, and the console asks on every settings view and every brain change. So answer from
   * the last result and refresh it in the background when it is older than a minute.
   * `fresh` waits for a new probe: use it before refusing a harness the cache does not list,
   * since the person may have just installed it.
   */
  async availableHarnesses(fresh = false): Promise<readonly HarnessInfo[]> {
    const cached = this.harnessList;
    if (!fresh && cached?.value) {
      if (Date.now() - cached.at > 60_000) void this.probeHarnesses().catch(() => {});
      return cached.value;
    }
    return this.probeHarnesses();
  }

  private harnessList?: { value?: readonly HarnessInfo[]; at: number } | undefined;
  private harnessProbe?: Promise<readonly HarnessInfo[]> | undefined;

  /** One probe at a time; callers arriving meanwhile share it. A dropped probe keeps nothing. */
  private probeHarnesses(): Promise<readonly HarnessInfo[]> {
    if (this.harnessProbe) return this.harnessProbe;
    const probe: Promise<readonly HarnessInfo[]> = this.options.harness
      .available()
      .then((value) => {
        if (this.harnessProbe === probe) this.harnessList = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        if (this.harnessProbe === probe) this.harnessProbe = undefined;
      });
    this.harnessProbe = probe;
    return probe;
  }

  /**
   * Every harness, installed or not, for Settings and the new-agent page. Finding out probes
   * them all, like `availableHarnesses`, so it is cached the same way. The console reads the
   * cached answer to open at once, then a `fresh` one to catch installs made outside Mingle.
   */
  async brainCatalog(fresh = false): Promise<readonly HarnessStatus[]> {
    const cached = this.catalogList;
    if (!fresh && cached) {
      if (Date.now() - cached.at > 60_000) void this.probeCatalog().catch(() => {});
      return cached.value;
    }
    return this.probeCatalog();
  }

  private catalogList?: { value: readonly HarnessStatus[]; at: number } | undefined;
  private catalogProbe?: Promise<readonly HarnessStatus[]> | undefined;

  private probeCatalog(): Promise<readonly HarnessStatus[]> {
    const catalog = this.options.harness.catalog;
    if (!catalog) return Promise.resolve([]);
    if (this.catalogProbe) return this.catalogProbe;
    const probe: Promise<readonly HarnessStatus[]> = catalog
      .call(this.options.harness)
      .then((value) => {
        if (this.catalogProbe === probe) this.catalogList = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        if (this.catalogProbe === probe) this.catalogProbe = undefined;
      });
    this.catalogProbe = probe;
    return probe;
  }

  /**
   * Asking a harness for its models starts it, which takes seconds; the console asks often.
   * Keep a good answer for five minutes. Failures and sign-in prompts are not kept.
   */
  async harnessModels(id: string) {
    if (!this.options.harness.models) return { kind: "unsupported" as const };
    const cached = this.modelCache.get(id);
    if (cached && cached.until > Date.now()) return cached.list;
    const list = await this.options.harness.models(id);
    if (list.kind === "ok") this.modelCache.set(id, { list, until: Date.now() + 5 * 60_000 });
    return list;
  }

  private readonly modelCache = new Map<
    string,
    { list: Awaited<ReturnType<NonNullable<Harness["models"]>>>; until: number }
  >();

  /**
   * Rename the agent or give it another brain. A new harness cannot resume the old one's
   * session, so it starts fresh (MEMORY.md carries what matters); a new model keeps it.
   */
  async updateAgent(idOrSlug: string, patch: { name?: string; harness?: string; model?: string | null }) {
    const agent = this.agent(idOrSlug);
    const name = patch.name?.trim();
    if (patch.name !== undefined && !name) throw new MingleError("name_required", "give the agent a name");
    const harnessChanged = patch.harness !== undefined && patch.harness !== agent.harness;
    this.store.updateAgent(agent.id, {
      ...(name ? { name } : {}),
      ...(patch.harness !== undefined ? { harness: patch.harness } : {}),
      ...(patch.model !== undefined ? { model: patch.model || null } : {}),
    });
    if (harnessChanged) {
      this.store.setSessionId(agent.id, null);
      // A different brain can be a different account: its quota scope changes with it.
      this.rescope(agent.id);
    }
    const brainChanged = harnessChanged || (patch.model !== undefined && (patch.model || null) !== agent.model);
    // The name is in the appended system prompt too, so either change reopens the session.
    if (brainChanged || (name && name !== agent.name)) await this.runtimes.get(agent.id)?.restart();
    return this.agent(agent.id);
  }

  /**
   * Give the agent a picture for the console (docs/spec.md 8.1). Each picture gets a new
   * unguessable file name, so its URL can be cached for good and works only while current.
   */
  setAvatar(idOrSlug: string, image: Uint8Array): Agent {
    const agent = this.agent(idOrSlug);
    const type = imageType(image);
    if (!type) throw new MingleError("avatar_invalid", "use a PNG, JPEG or WebP image");
    if (image.byteLength > AVATAR_MAX_BYTES) throw new MingleError("avatar_too_large", "use an image under 2 MB", 413);
    const file = `${agent.id}-${randomBytes(9).toString("base64url")}.${type}`;
    writeFileSync(join(this.options.paths.avatars, file), image);
    this.store.setAvatar(agent.id, file);
    this.removeAvatar(agent.avatar);
    return this.agent(agent.id);
  }

  /** Back to the generated initial. */
  clearAvatar(idOrSlug: string): Agent {
    const agent = this.agent(idOrSlug);
    this.store.setAvatar(agent.id, null);
    this.removeAvatar(agent.avatar);
    return this.agent(agent.id);
  }

  /** Where a current picture is on disk; undefined for any name that is not some agent's picture now. */
  avatarPath(file: string): string | undefined {
    if (!AVATAR_FILE.test(file)) return undefined;
    if (!this.store.agents().some((a) => a.avatar === file)) return undefined;
    return join(this.options.paths.avatars, file);
  }

  private removeAvatar(file: string | null): void {
    if (file && AVATAR_FILE.test(file)) rmSync(join(this.options.paths.avatars, file), { force: true });
  }

  createAgent(input: { name: string; role: string; harness: string; model?: string | null }): Agent {
    const name = input.name.trim();
    if (!name) throw new MingleError("name_required", "give the agent a name");
    const base = slugify(name);
    let slug = base;
    for (let i = 2; this.store.agent(slug) || existsSync(join(this.options.paths.agents, slug)); i++)
      slug = `${base}-${i}`;
    const agent = this.store.createAgent({ name, slug, harness: input.harness, model: input.model ?? null });
    createHome(this.homeDir(agent), name, input.role);
    this.addRuntime(agent).start();
    const local = this.ensureLocalChat(agent.id);
    void this.reconnect(local.id).catch((error) =>
      this.log(`the private chat of ${agent.name} could not open: ${(error as Error).message}`),
    );
    return agent;
  }

  agent(idOrSlug: string): Agent {
    const agent = this.store.agent(idOrSlug);
    if (!agent) throw notFound("agent", idOrSlug);
    return agent;
  }

  async setRole(idOrSlug: string, role: string): Promise<void> {
    const agent = this.agent(idOrSlug);
    writeRole(this.homeDir(agent), role);
    // The role is part of the appended system prompt; reopen so it takes effect.
    await this.runtimes.get(agent.id)?.restart();
  }

  // -------------------------------------------------------------- agent env

  /** The agent's variables by name, and whether each value is still in the secret store. Never the values. */
  async envList(idOrSlug: string): Promise<{ name: string; updatedAt: number; missing: boolean }[]> {
    const agent = this.agent(idOrSlug);
    return Promise.all(
      this.store.envNames(agent.id).map(async (v) => ({
        ...v,
        missing: (await this.options.secrets.get(envRef(agent.id, v.name)).catch(() => undefined)) === undefined,
      })),
    );
  }

  /** Add or replace a variable. Applies from the next message (docs/spec.md 4.4). */
  async setEnv(idOrSlug: string, name: string, value: unknown): Promise<void> {
    const agent = this.agent(idOrSlug);
    checkEnvName(name);
    checkEnvValue(value);
    try {
      await this.options.secrets.set(envRef(agent.id, name), encodeEnvValue(value));
    } catch {
      // The store's own error could carry the value (a command line, say): report without it.
      throw new MingleError("env_save_failed", "the system credential store did not save it; try again", 500);
    }
    this.store.putEnvName(agent.id, name);
    // A harness that ignores the agent's environment keeps the computer's sign-in whatever the
    // variable is called, so it alone does not change the scope.
    if (OWN_SIGN_IN.test(name) && this.options.harness.acceptsEnv?.(agent.harness) !== false) this.rescope(agent.id);
    await this.runtimes.get(agent.id)?.refresh();
  }

  async deleteEnv(idOrSlug: string, name: string): Promise<void> {
    const agent = this.agent(idOrSlug);
    if (!this.store.deleteEnvName(agent.id, name)) {
      throw new MingleError("env_not_found", `no variable ${name} on this agent`, 404);
    }
    await this.options.secrets.delete(envRef(agent.id, name)).catch(() => {});
    if (OWN_SIGN_IN.test(name) && this.options.harness.acceptsEnv?.(agent.harness) !== false) this.rescope(agent.id);
    await this.runtimes.get(agent.id)?.refresh();
  }

  /**
   * The agent's credentials or harness changed, so its next session belongs to a fresh quota
   * scope (docs/spec.md 4.3). Persist what the new scope waits for now — a shared scope inherits
   * the ledger entry already in force — and let its waiting messages go once the new session
   * can reach them. The session still running keeps the scope it opened with; `onSession`
   * reconciles the gate when the replacement starts opening. No secret values are ever part
   * of a scope key, a log line or the database.
   */
  private rescope(agentId: string): void {
    if (!this.store.agent(agentId)) return;
    this.signInVersions.set(agentId, (this.signInVersions.get(agentId) ?? 0) + 1);
    this.saveLimitFor(agentId);
    this.store.readyWaiting(agentId, Date.now());
  }

  /** Name to value for the harness. A value missing from the secret store is left out, not an error. */
  private agentEnv(agentId: string): Promise<Record<string, string>> | undefined {
    const names = this.store.envNames(agentId);
    if (names.length === 0) return undefined;
    return (async () => {
      const env: Record<string, string> = {};
      for (const { name } of names) {
        const stored = await this.options.secrets.get(envRef(agentId, name)).catch(() => undefined);
        if (stored !== undefined) env[name] = decodeEnvValue(stored);
      }
      return env;
    })();
  }

  async deleteAgent(idOrSlug: string, removeHome: boolean): Promise<void> {
    const agent = this.agent(idOrSlug);
    // From here on no check may start for this agent, and what runs is let go.
    this.deleting.add(agent.id);
    this.abortCheck(agent.id);
    try {
      for (const connection of this.store.connections(agent.id)) await this.removeConnection(connection.id);
      for (const { name } of this.store.envNames(agent.id)) {
        await this.options.secrets.delete(envRef(agent.id, name)).catch(() => {});
      }
      await this.runtimes.get(agent.id)?.dispose();
      await this.lines.suspend(agent.id);
      await this.closing.get(agent.id);
      this.runtimes.delete(agent.id);
      this.revokeTokens(agent.id);
      this.paused.delete(agent.id);
      this.store.deleteAgent(agent.id);
      this.removeAvatar(agent.avatar);
      rmSync(join(this.options.paths.home, "lines", agent.slug), { recursive: true, force: true });
      rmSync(this.uploadsDir(agent.id), { recursive: true, force: true });
      if (removeHome) rmSync(this.homeDir(agent), { recursive: true, force: true });
    } finally {
      this.deleting.delete(agent.id);
    }
  }

  /** Stop what the agent is doing: its main session's turn and every line's (docs/spec.md 4.13). */
  async stopAgent(idOrSlug: string): Promise<boolean> {
    const agent = this.agent(idOrSlug);
    const [main, lines] = await Promise.all([
      this.runtimes.get(agent.id)?.stop() ?? Promise.resolve(false),
      this.lines.stopAll(agent.id),
    ]);
    return main || lines;
  }

  /**
   * Start the agent over in a new harness session (docs/spec.md 4.11), for a session that is
   * stuck or too muddled to recover. A paused agent opens the new session when resumed.
   */
  async resetSession(idOrSlug: string): Promise<void> {
    const agent = this.agent(idOrSlug);
    const runtime = this.runtimes.get(agent.id);
    const notes = runtime?.takePendingNotes() ?? [];
    // The old session's token is retired with it: its background work cannot send any more.
    this.revokeTokens(agent.id);
    for (const id of this.replies.openFor(agent.id)) this.replies.settle(id, "stopped");
    this.runtimes.delete(agent.id);
    let closing = this.closing.get(agent.id);
    if (runtime) {
      const previous = closing;
      const retiring = runtime.dispose("offline", true);
      const done = Promise.all([previous, retiring])
        .then(() => {})
        .finally(() => {
          if (this.closing.get(agent.id) === done) this.closing.delete(agent.id);
        });
      closing = done;
      this.closing.set(agent.id, done);
    }
    // Already delivered work will not be answered by the retired session; queued and waiting
    // messages stay for the replacement.
    this.store.moveInbound(
      this.store.awaitingReply(agent.id).map((m) => m.id),
      "give_up",
    );
    this.store.setSessionId(agent.id, null);
    if (!this.paused.has(agent.id)) {
      const replacement = this.addRuntime(this.agent(agent.id));
      // The old session may still be closing; the replacement opens only once it is gone.
      replacement.start(closing);
      for (const note of notes) replacement.enqueueText(note);
    }
    this.log(`${agent.name}: session reset`);
  }

  /**
   * What someone helping needs to see why an agent misbehaves, as plain text to paste anywhere:
   * versions, brain, session, status, bots and message counts. Never message text, names of the
   * people it talks to, credentials or variable values.
   */
  async diagnostics(idOrSlug: string): Promise<string> {
    const agent = this.agent(idOrSlug);
    const harnesses = await this.availableHarnesses().catch(() => [] as readonly HarnessInfo[]);
    const harness = harnesses.find((h) => h.id === agent.harness);
    const now = Date.now();
    const counts = this.store.inboundCounts(agent.id, now - 7 * 86_400_000);
    const states = ["received", "delivered", "waiting", "replied", "unanswered", "failed", "ignored", "held"];
    const iso = (ms: number | null) => (ms == null ? "never" : new Date(ms).toISOString());
    const last = this.store.lastMessageTimes(agent.id);
    const quota = this.store.quotaWait(agent.id);
    const wait = quota && quota.until > now ? quota : undefined;
    // Only structured states belong in a shareable report; raw provider/adapter errors may
    // contain request data.
    const lines = [
      "Mingle diagnostic info",
      `time: ${new Date(now).toISOString()}`,
      `mingle: ${VERSION} · node ${process.version} · ${process.platform} ${arch()} ${release()}`,
      `agent: ${agent.id} · status ${agent.status}${agent.statusFailure ? ` (${agent.statusFailure})` : ""}`,
      `brain: ${agent.harness}${harness?.version ? ` ${harness.version}` : ""}${harness ? "" : " (not found on this computer)"} · model ${agent.model ?? "default"}`,
      `session: ${agent.sessionId ?? "none"}`,
      // Whose usage limit it shares: the computer's sign-in of its harness, or its own key.
      `sign-in: ${this.signIn(agent.id).startsWith("shared:") ? "this computer's" : "its own"}${wait ? ` · usage-limit wait until ${iso(wait.until)}${wait.resetsAt ? ` (reset ${iso(wait.resetsAt)})` : ""}` : ""}`,
      `last message in: ${iso(last.inAt)} · last reply out: ${iso(last.outAt)}`,
      `memory: MEMORY.md ${memorySize(this.homeDir(agent))} bytes`,
      "chat apps:",
      ...this.store.connections(agent.id).map((n) => {
        const state = this.isLive(n.id) ? n.state : n.state === "connected" ? "reconnecting" : n.state;
        return `  ${n.platform} ${n.id} · ${state}${n.ownerId ? "" : " · no owner"}`;
      }),
      `messages, last 7 days: ${states.map((k) => `${k} ${counts[k] ?? 0}`).join(" · ")}`,
      `tasks open: ${this.store.tasks(agent.id, false).length} · reminders: ${this.store.reminders(agent.id).length}`,
    ];
    return `${lines.join("\n")}\n`;
  }

  /** What the owner gives a local agent so it finds why this agent misbehaves and files an issue. */
  async diagnosisPrompt(idOrSlug: string): Promise<string> {
    const agent = this.agent(idOrSlug);
    return diagnosisPrompt(agent, await this.diagnostics(agent.id), this.cliPath, VERSION);
  }

  isPaused(agentId: string): boolean {
    return this.paused.has(agentId);
  }

  /**
   * Pause an agent (docs/spec.md 4.11): end the work in hand, close its session and revoke its CLI
   * token, so it neither takes in nor sends anything until resumed. Its bots stay connected, so
   * Mingle can tell people it is paused. Returns false when it was already paused.
   */
  async pauseAgent(idOrSlug: string): Promise<boolean> {
    const agent = this.agent(idOrSlug);
    if (this.paused.has(agent.id)) return false;
    // From here on, new messages take the paused path in receive().
    this.paused.add(agent.id);
    // Its check commands stop too; a result landing after this is dropped.
    this.abortCheck(agent.id);
    // A background job of the old session must not speak for it any more.
    this.revokeTokens(agent.id);
    // Its lines stop too, and pick up where they were when it is resumed.
    void this.lines.suspend(agent.id);
    for (const id of this.replies.openFor(agent.id)) this.replies.settle(id, "paused");
    const runtime = this.runtimes.get(agent.id);
    this.runtimes.delete(agent.id);
    if (runtime) {
      // The status is paused at once; closing the session can take a while (one still opening
      // is closed once it is up), and the owner does not wait for it.
      const closing = runtime.dispose("paused").finally(() => {
        if (this.closing.get(agent.id) === closing) this.closing.delete(agent.id);
      });
      this.closing.set(agent.id, closing);
    } else {
      this.store.setAgentStatus(agent.id, "paused");
    }
    // What it had not answered yet will not be answered; failed and unanswered ones wait for the owner.
    const awaiting = [
      ...this.store.undelivered(agent.id),
      ...this.store.awaitingReply(agent.id),
      ...this.store.waiting(agent.id),
    ];
    this.store.moveInbound(
      awaiting.map((m) => m.id),
      "pause",
    );
    this.log(`${agent.name} paused`);
    return true;
  }

  /** Resume a paused agent: open its session again and fire the reminders that came due meanwhile. */
  async resumeAgent(idOrSlug: string): Promise<boolean> {
    const agent = this.agent(idOrSlug);
    if (!this.paused.delete(agent.id)) return false;
    for (const chat of this.store.agentChats(agent.id)) this.pauseNoted.delete(chat.id);
    this.store.setAgentStatus(agent.id, "offline");
    // Never two sessions of one agent: the new one opens once the paused one has closed.
    this.addRuntime(agent).start(this.closing.get(agent.id));
    this.lines.restore(agent.id);
    this.fireReminders();
    this.log(`${agent.name} resumed`);
    return true;
  }

  private revokeTokens(agentId: string): void {
    for (const [token, id] of this.tokens) if (id === agentId) this.tokens.delete(token);
    for (const [token, line] of this.lineTokens) if (line.agentId === agentId) this.lineTokens.delete(token);
  }

  /** The agent a CLI token belongs to: its main session's, or one of its lines'. */
  agentForToken(token: string): Agent | undefined {
    const id = this.tokens.get(token) ?? this.lineTokens.get(token)?.agentId;
    return id ? this.store.agent(id) : undefined;
  }

  /** The task a line's token is scoped to; undefined for the agent's main session. */
  lineForToken(token: string): string | undefined {
    return this.lineTokens.get(token)?.taskId;
  }

  /** The token a line speaks with; one per task, kept while it lives. */
  private lineToken(agentId: string, taskId: string): string {
    for (const [token, line] of this.lineTokens) if (line.taskId === taskId) return token;
    const token = randomBytes(24).toString("base64url");
    this.lineTokens.set(token, { agentId, taskId });
    return token;
  }

  runtime(agentId: string): AgentRuntime | undefined {
    return this.runtimes.get(agentId);
  }

  private addRuntime(agent: Agent): AgentRuntime {
    const token = randomBytes(24).toString("base64url");
    this.tokens.set(token, agent.id);
    const runtime = new AgentRuntime(agent.id, {
      store: this.store,
      harness: this.options.harness,
      homeDir: this.homeDir(agent),
      env: () => ({ MINGLE_API: this.apiUrl, MINGLE_TOKEN: token, MINGLE_CLI: this.cliPath }),
      agentEnv: () => this.agentEnv(agent.id),
      ...(this.options.coalesceMs !== undefined ? { coalesceMs: this.options.coalesceMs } : {}),
      ...(this.options.emptyTurnWaitMs !== undefined ? { emptyTurnWaitMs: this.options.emptyTurnWaitMs } : {}),
      ...(this.options.stallMs !== undefined ? { stallMs: this.options.stallMs } : {}),
      coldStart: { rebuild: coldRebuildFor(this.options.coldStart, agent) },
      onActivity: (kind, detail) => this.replies.activity(agent.id, kind, detail),
      onSettled: (ids, outcome, why) => {
        const note = why && { ...why, harness: this.harnessName(agent.id) };
        for (const id of ids) this.replies.settle(id, outcome, note);
      },
      signIn: () => this.signIn(agent.id),
      limitRevision: (key) => this.limits.get(key)?.revision,
      onSession: (key, changed) => {
        // The new session runs on `key`. Only a scope change reconciles the gate: re-applying
        // it on every open would undo an owner retry's deliberate bypass of the account wait.
        const active = this.runtimes.get(agent.id);
        if (changed) {
          active?.release();
          const wait = this.limits.get(key);
          if (wait) active?.holdFor(wait.until, wait.why);
          this.store.readyWaiting(agent.id, Date.now());
        }
        this.resumeWaiting();
      },
      onLimit: (key, until, why) => this.shareLimit(key, until, why),
      onTurnCompleted: (key, revision) => this.endLimit(key, revision),
      log: (line) => this.log(line),
    });
    this.runtimes.set(agent.id, runtime);
    // A wait already holding its sign-in holds this agent too: persisted at once, so a restart
    // restores it even if the agent that reported it has moved to a scope of its own by then.
    this.saveLimitFor(agent.id);
    const wait = this.limits.get(this.signIn(agent.id));
    if (wait && wait.until > Date.now()) runtime.holdFor(wait.until, wait.why);
    return runtime;
  }

  /**
   * Whose usage limit an agent runs into (docs/spec.md 4.3). Limits belong to the provider account,
   * so agents on the computer's own sign-in of one harness share them. An agent given its own key,
   * token, endpoint or config directory in its variables has a limit of its own.
   */
  private signIn(agentId: string): string {
    const agent = this.store.agent(agentId);
    if (!agent) return `agent:${agentId}:0`;
    // A harness that ignores the agent's environment (Cursor) can only ever use this
    // computer's sign-in, whatever variables the owner saved.
    const own =
      this.options.harness.acceptsEnv?.(agent.harness) !== false &&
      this.store.envNames(agentId).some(({ name }) => OWN_SIGN_IN.test(name));
    return own ? `agent:${agentId}:${this.signInVersions.get(agentId) ?? 0}` : `shared:${agent.harness}`;
  }

  /** Persist this agent's current scope's wait, or clear it when the scope waits for nothing. */
  private saveLimitFor(agentId: string): void {
    const wait = this.limits.get(this.signIn(agentId));
    this.store.setQuotaWait(
      agentId,
      wait && wait.until > Date.now() ? { until: wait.until, resetsAt: wait.why.resetsAt ?? null } : undefined,
    );
  }

  /** A session on `key` hit its usage limit: every agent sharing it waits for the latest deadline. */
  private shareLimit(key: string, until: number, why: FailureInfo): void {
    const previous = this.limits.get(key);
    const wait = previous && previous.until > until ? { until: previous.until, why: previous.why } : { until, why };
    // Every new quota report gets a new revision even if its deadline is shorter/equal.
    this.limits.set(key, { ...wait, revision: ++this.limitRevision });
    for (const agent of this.store.agents()) if (this.signIn(agent.id) === key) this.saveLimitFor(agent.id);
    for (const runtime of this.runtimes.values()) if (runtime.signIn === key) runtime.holdFor(wait.until, wait.why);
  }

  /**
   * A turn that began while the ledger was at `revision` completed on `key`, so the provider
   * answers again: the wait is over for every agent sharing it — including the one whose manual
   * retry only bypassed its own gate — and their waiting messages go out now, not at the old
   * retry time. A newer quota report (a different revision) is not cleared by an older success.
   */
  private endLimit(key: string, revision: number | undefined): void {
    const wait = this.limits.get(key);
    if (!wait || wait.revision !== revision) return;
    this.limits.delete(key);
    const now = Date.now();
    // Persist that the wait is over before reaching for delivery: a message whose chat app is
    // offline is ready the moment it reconnects or Mingle restarts, not at its old deadline.
    for (const agent of this.store.agents()) {
      if (this.signIn(agent.id) === key) {
        this.store.setQuotaWait(agent.id);
        this.store.readyWaiting(agent.id, now);
      }
    }
    for (const runtime of this.runtimes.values()) if (runtime.signIn === key) runtime.release();
    this.log("usage limit over (a turn completed)");
    this.resumeWaiting(now);
  }

  /** The agent's harness by its display name, for messages to people. */
  harnessName(agentId: string): string {
    const harness = this.store.agent(agentId)?.harness ?? "";
    return this.options.harness.name?.(harness) ?? harness;
  }

  // ------------------------------------------------------------- connections

  hasChannel(platform: Platform): boolean {
    return Boolean(this.channels[platform]);
  }

  channel(platform: Platform): Channel {
    const channel = this.channels[platform];
    if (!channel) throw new MingleError("platform_unsupported", `${platform} is not supported yet`);
    return channel;
  }

  /** Connect a bot with credentials (token-style platforms). QR onboarding goes through the console. */
  /** Connect a bot with credentials (token-style platforms, or manual App ID / Secret). */
  async addConnection(agentId: string, platform: Platform, credentials: Credentials): Promise<Connection> {
    const agent = this.agent(agentId);
    const abort = new AbortController();
    for await (const event of this.channel(platform).onboard(credentials, abort.signal, { agentName: agent.name })) {
      if (event.kind === "failed") throw onboardingError(platform, event.code);
      if (event.kind === "succeeded") return this.finishOnboarding(agent.id, platform, event);
    }
    throw new MingleError("onboarding_unknown", "the chat app did not finish connecting; try again");
  }

  /**
   * Start a QR (or other multi-step) onboarding the console follows by polling `onboarding(id)`.
   * With `connectionId`, this is a re-authorization of that already-connected bot: the platform
   * adds permissions to the same app instead of creating a new one (`Channel.reauthorize`).
   */
  startOnboarding(
    agentId: string,
    platform: Platform,
    connectionId?: string,
    adding: readonly PermissionId[] = [],
  ): OnboardingSession {
    const agent = this.agent(agentId);
    const channel = this.channel(platform);
    const updating = connectionId ? this.store.connection(connectionId) : undefined;
    if (connectionId && (!updating || updating.agentId !== agent.id || updating.platform !== platform))
      throw notFound("connection", connectionId);
    if (updating && !channel.reauthorize)
      throw new MingleError("reauthorize_unsupported", `${platform} cannot add permissions to a connected bot`);
    for (const [id, old] of this.onboardings) {
      if (old.agentId === agent.id && old.platform === platform) this.cancelOnboarding(id);
    }
    const abort = new AbortController();
    const session: OnboardingSession = {
      id: randomBytes(9).toString("base64url"),
      agentId: agent.id,
      platform,
      state: { kind: "starting" },
      abort,
      updatedAt: Date.now(),
    };
    this.onboardings.set(session.id, session);
    const set = (state: OnboardingSession["state"]) => {
      session.state = state;
      session.updatedAt = Date.now();
    };
    void (async () => {
      try {
        const awaitCode = () =>
          new Promise<string>((resolve) => {
            session.submitCode = (code) => {
              session.submitCode = undefined;
              resolve(code);
            };
          });
        const knownCredentials = () => this.knownCredentials(platform);
        // Re-authorizing a connected bot: the platform updates that app instead of making one.
        const reauthorize = updating ? await this.credentials(updating) : undefined;
        if (updating && !reauthorize)
          throw new MingleError("credentials_missing", "the bot's credentials are gone; connect it again");
        for await (const event of channel.onboard(undefined, abort.signal, {
          agentName: agent.name,
          awaitCode,
          knownCredentials,
          ...(reauthorize ? { reauthorize } : {}),
          ...(reauthorize && adding.length ? { adding } : {}),
        })) {
          if (event.kind === "qr_ready") set({ kind: "qr", content: event.qrContent, expiresAt: event.expiresAt });
          else if (event.kind === "scanned") set({ kind: "scanned" });
          else if (event.kind === "device_code")
            set({ kind: "device", userCode: event.userCode, url: event.verificationUri, expiresAt: event.expiresAt });
          else if (event.kind === "awaiting_approval") set({ kind: "awaiting_approval" });
          else if (event.kind === "needs_code") set({ kind: "needs_code", retry: Boolean(event.retry) });
          else if (event.kind === "failed") set({ kind: "failed", code: event.code });
          else if (event.kind === "succeeded") {
            const connection = await this.finishOnboarding(agent.id, platform, event);
            set({
              kind: "done",
              connectionId: connection.id,
              pendingApproval: Boolean(event.pendingApproval),
              bot: connection.botName ?? null,
            });
          }
        }
      } catch (error) {
        set({ kind: "failed", code: error instanceof MingleError ? error.code : "unknown" });
        this.log(`onboarding ${platform} for ${agent.name} failed: ${(error as Error).message}`);
      }
    })();
    // Forget finished sessions after a while.
    setTimeout(() => this.onboardings.delete(session.id), 30 * 60_000).unref();
    return session;
  }

  onboarding(id: string): OnboardingSession | undefined {
    return this.onboardings.get(id);
  }

  cancelOnboarding(id: string): void {
    const session = this.onboardings.get(id);
    session?.abort.abort();
    this.onboardings.delete(id);
  }

  private async finishOnboarding(
    agentId: string,
    platform: Platform,
    event: Extract<OnboardingEvent, { kind: "succeeded" }>,
  ): Promise<Connection> {
    // One bot, one connection: matched by platform bot id or by the secret reference it will
    // get, so a rebind reuses the connection instead of making a second one. Two onboardings
    // of the same bot can be in flight at once (the console and the CLI, say); the lookup and
    // the insert below must stay synchronous, or both would pass the check and create a pair
    // of connections sharing one secretRef — removing either would then cut the other's
    // credentials, and every message would arrive twice.
    const secretRef = `${platform}:${event.bot.id}`;
    const findExisting = () =>
      this.store
        .connections()
        .find((c) => c.platform === platform && (c.botId === event.bot.id || c.secretRef === secretRef));
    const existing = findExisting();
    if (existing) {
      // Binding a bot again can hand out new credentials and revoke the old ones (QQ issues a
      // fresh AppSecret on every scan), so the connection that already has this bot keeps
      // working only if it takes the new ones. Scanning again for the same agent is then a
      // successful rebind; for another agent it still fails, but leaves the first one intact.
      if (existing.secretRef) {
        await this.options.secrets.set(existing.secretRef, JSON.stringify(event.credentials));
        await this.reconnect(existing.id, event.credentials);
      }
      if (existing.agentId === agentId) return this.store.connection(existing.id) as Connection;
      throw new MingleError(
        "bot_in_use",
        `this bot is already connected to ${this.store.agent(existing.agentId)?.name ?? "another agent"}`,
      );
    }
    await this.options.secrets.set(secretRef, JSON.stringify(event.credentials));
    // The secret write above yielded: a concurrent onboarding of the same bot may have created
    // the connection meanwhile. Look again with no await before the insert, so only one wins.
    const raced = findExisting();
    if (raced) {
      if (raced.agentId === agentId) return this.store.connection(raced.id) as Connection;
      throw new MingleError(
        "bot_in_use",
        `this bot is already connected to ${this.store.agent(raced.agentId)?.name ?? "another agent"}`,
      );
    }
    const connection = this.store.createConnection({ agentId, platform, secretRef });
    this.store.updateConnection(connection.id, {
      botId: event.bot.id,
      botName: event.bot.name,
      ...(event.ownerId ? { ownerId: event.ownerId } : {}),
    });
    // The owner is in the address book from the start, so the console can name them before they write.
    if (event.ownerId) this.store.touchContact(connection.id, event.ownerId, null);
    // The platform did not say who set the bot up: whoever sends it this code becomes its owner.
    else if (this.channel(platform).directMessages !== false) this.issueClaim(connection.id);
    await this.reconnect(connection.id, event.credentials);
    if (event.ownerId)
      void this.greetOwner(connection.id, event.ownerId).catch((error) =>
        this.log(`greeting failed: ${(error as Error).message}`),
      );
    return this.store.connection(connection.id) as Connection;
  }

  /** A new bot says hello to its owner, so the conversation shows up in their chat list. */
  private async greetOwner(connectionId: string, ownerId: string): Promise<void> {
    const connection = this.store.connection(connectionId);
    const live = this.live.get(connectionId);
    const agent = connection && this.store.agent(connection.agentId);
    if (!live?.messageUser || !agent || connection.state !== "connected") return;
    const chinese = ["wechat", "wecom", "feishu", "dingtalk", "qq"].includes(connection.platform);
    const text = live.ownerOnly
      ? chinese
        ? `你好，我是 ${agent.name}。直接在这里给我发消息。`
        : `Hi, I'm ${agent.name}. Message me here.`
      : chinese
        ? `你好，我是 ${agent.name}。直接在这里给我发消息，或者把我拉进群里 @ 我。`
        : `Hi, I'm ${agent.name}. Message me here, or add me to a group and @ me.`;
    await this.messageOwner(connectionId, ownerId, text).catch((error) =>
      this.log(`greeting failed: ${(error as Error).message}`),
    );
  }

  /**
   * A line of Mingle's own to the bot's owner: in their direct chat with the bot when there is one,
   * else by opening it. Kept with the chat as a notice, so the console shows what the owner got.
   */
  private async messageOwner(connectionId: string, ownerId: string, text: string): Promise<void> {
    const known = this.store.directChatWith(connectionId, ownerId) ?? this.store.directChat(connectionId, ownerId);
    if (known) return this.note(connectionId, known, text);
    const live = this.live.get(connectionId);
    if (!live?.messageUser) return;
    const sent = await live.messageUser(ownerId, text);
    if (!sent) return; // The platform did not say where it went: nothing to keep it with.
    const owner = this.store.contactByPlatformId(connectionId, ownerId);
    const chat = this.store.upsertChat({
      connectionId,
      platformId: sent.chat,
      kind: "dm",
      ...(owner?.name ? { name: owner.name } : {}),
      peerId: ownerId,
    });
    const record = this.store.insertOutbound({ chatId: chat.id, body: text, replyTo: null, notice: true });
    this.store.setOutboundResult(record.id, "sent", sent.platformId ?? null);
  }

  /**
   * A fresh one-time code for an ownerless bot (docs/spec.md 4.7): the first direct message that
   * carries it makes its sender the owner. Valid for ten minutes; a new one replaces the old.
   */
  issueClaim(connectionId: string): { code: string; expiresAt: number } {
    const connection = this.store.connection(connectionId);
    if (!connection) throw notFound("connection", connectionId);
    if (connection.ownerId) throw new MingleError("owner_known", "this bot already has its owner", 409);
    if (this.channel(connection.platform).directMessages === false) {
      throw new MingleError("claim_unsupported", "nobody can message this bot directly", 409);
    }
    const claim = { code: claimCode(), expiresAt: Date.now() + CLAIM_TTL_MS };
    this.store.updateConnection(connectionId, { claimCode: claim.code, claimExpiresAt: claim.expiresAt });
    this.claimMisses.delete(connectionId);
    return claim;
  }

  async removeConnection(connectionId: string): Promise<void> {
    const connection = this.store.connection(connectionId);
    if (!connection) return;
    this.drive(connectionId, { kind: "remove" });
    this.links.delete(connectionId);
    if (connection.secretRef && !this.isBuiltin(connection)) await this.options.secrets.delete(connection.secretRef);
    this.store.deleteConnection(connectionId);
  }

  /** A connection Mingle makes itself (the console's private chat), not a chat app the owner added. */
  isBuiltin(connection: Pick<Connection, "platform">): boolean {
    return Boolean(this.channels[connection.platform]?.builtin);
  }

  /** The agent's private chat in the console (docs/spec.md 6.9), made the first time it is needed. */
  ensureLocalChat(agentId: string): Connection {
    const existing = this.localConnection(agentId);
    if (existing) return existing;
    const connection = this.store.createConnection({ agentId, platform: "local", secretRef: `local:${agentId}` });
    // The one person in it is the owner: nothing to claim, nobody to let in.
    this.store.updateConnection(connection.id, { botId: connection.id, botName: "Mingle", ownerId: LOCAL_OWNER });
    return this.store.connection(connection.id) as Connection;
  }

  localConnection(agentId: string): Connection | undefined {
    return this.store.connections(agentId).find((n) => this.isBuiltin(n));
  }

  /** The private chat's one chat, once the owner said something there. */
  localChatOf(agentId: string): Chat | undefined {
    const connection = this.localConnection(agentId);
    return connection ? this.store.agentChats(agentId).find((c) => c.connectionId === connection.id) : undefined;
  }

  /**
   * The owner said something to the agent in the console (docs/spec.md 6.9). It goes in like any
   * direct message: the same inbox, session, lines, pause and /stop. Returns the stored message.
   */
  sayLocally(idOrSlug: string, input: { text: string; files: readonly LocalFile[] }): Message {
    const agent = this.agent(idOrSlug);
    const text = input.text.trim();
    if (!text && input.files.length === 0) throw new MingleError("empty_message", "write something or attach a file");
    const connection = this.ensureLocalChat(agent.id);
    const platformId = this.localChat.post(connection.id, { text, files: input.files });
    if (!platformId)
      throw new MingleError("chat_starting", "Mingle is still opening this chat; try again in a moment", 503);
    const chat = this.localChatOf(agent.id);
    const message = chat && this.store.messageByPlatformId(chat.id, platformId);
    if (!message) throw new MingleError("internal", "the message was not kept; check ~/.mingle/logs", 500);
    return message;
  }

  /** Where files the owner attaches in the private chat are kept, one folder each. */
  private uploadsDir(agentId: string): string {
    return join(this.options.paths.home, "uploads", agentId);
  }

  /** Keep a file the owner is about to send in the private chat. Returns the handle `sayLocally` takes. */
  saveUpload(idOrSlug: string, input: { name: string; bytes: Uint8Array; mime?: string }): LocalUpload {
    const agent = this.agent(idOrSlug);
    if (input.bytes.byteLength > UPLOAD_MAX_BYTES)
      throw new MingleError("file_too_large", "send files under 100 MB", 413);
    // Only the last part of the name, without control characters a file system or a terminal would trip on.
    const last = input.name.split(/[\\/]/).pop() ?? "";
    const base = [...last]
      .filter((c) => c >= " " && c !== "\u007f")
      .join("")
      .trim()
      .slice(0, 200);
    const name = base && base !== "." && base !== ".." ? base : "file";
    const id = randomBytes(9).toString("base64url");
    const dir = join(this.uploadsDir(agent.id), id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), input.bytes);
    return { id, name, size: input.bytes.byteLength, ...(input.mime ? { mime: input.mime } : {}) };
  }

  /** A kept upload as the private chat sends it, or undefined for a handle that is not one. */
  upload(agentId: string, id: string): LocalFile | undefined {
    if (!/^[A-Za-z0-9_-]{12}$/.test(id)) return undefined;
    const dir = join(this.uploadsDir(agentId), id);
    let name: string | undefined;
    try {
      name = readdirSync(dir)[0];
    } catch {
      return undefined;
    }
    if (!name) return undefined;
    const path = join(dir, name);
    return { path, name, size: statSync(path).size, ...(mimeOf(name) ? { mime: mimeOf(name) as string } : {}) };
  }

  isLive(connectionId: string): boolean {
    return this.live.has(connectionId);
  }

  liveConnection(connectionId: string): ChannelConnection | undefined {
    return this.live.get(connectionId);
  }

  /** When an offline bot tries again by itself, or null when it does not (connected, or waiting for the person). */
  retryAt(connectionId: string): number | null {
    const state = this.links.get(connectionId)?.state;
    return state?.kind === "waiting" ? state.retryAt : null;
  }

  /**
   * Connect a bot again now: at start, after sleep, or when the person asks. Closes what is
   * there and starts a fresh attempt; resolves when that attempt ends, whichever way.
   */
  async reconnect(connectionId: string, credentials?: Credentials): Promise<void> {
    const connection = this.store.connection(connectionId);
    if (!connection?.secretRef) return; // nothing to connect with yet
    if (!this.links.has(connectionId))
      this.links.set(connectionId, { state: { kind: "connecting", attempt: 0 }, gen: 0 });
    await this.drive(connectionId, { kind: "connect" }, undefined, credentials);
  }

  /**
   * Feed one event to a bot's state machine, persist where it lands, and carry out its
   * effect. `gen` ties an event to the attempt it came from: events of an attempt that was
   * replaced (reconnected, removed) are dropped, so a late report cannot undo a newer state.
   */
  private drive(id: string, event: LinkEvent, gen?: number, credentials?: Credentials): Promise<void> {
    const link = this.links.get(id);
    if (!link || (gen !== undefined && gen !== link.gen)) return Promise.resolve();
    // This runs inside timer and adapter callbacks: a store error must not escape as an
    // uncaught exception and take the whole process down.
    let state: LinkState;
    let effect: LinkEffect;
    try {
      ({ state, effect } = step(link.state, event, Date.now(), this.options.reconnectDelaysMs ?? BACKOFF_MS));
      link.state = state;
      if (state.kind !== "removed") this.store.updateConnection(id, stored(state));
    } catch (error) {
      this.log(`connection ${id} state update failed: ${(error as Error).message}`);
      return Promise.resolve();
    }
    if (effect === "none") return Promise.resolve();
    clearTimeout(link.timer);
    link.timer = undefined;
    this.closeLive(id);
    if (effect === "retry_later" && state.kind === "waiting") {
      this.log(
        `connection ${id} is offline (${state.code}); trying again in ${Math.round((state.retryAt - Date.now()) / 1000)}s`,
      );
      link.timer = setTimeout(() => void this.drive(id, { kind: "timer" }), Math.max(0, state.retryAt - Date.now()));
      link.timer.unref?.();
    } else if (effect === "close" && state.kind === "stopped") {
      this.log(`connection ${id} stopped (${state.code}); waiting for the owner`);
    }
    if (effect !== "connect") return Promise.resolve();
    link.gen++;
    return this.attempt(id, link.gen, credentials).catch((error) =>
      this.log(`connection ${id} attempt failed unexpectedly: ${(error as Error).message}`),
    );
  }

  private closeLive(id: string): void {
    const live = this.live.get(id);
    this.live.delete(id);
    void live?.close().catch(() => {});
  }

  /** One connect attempt. Its outcome goes back into the state machine as `opened` or `failed`. */
  private async attempt(id: string, gen: number, given?: Credentials): Promise<void> {
    const connection = this.store.connection(id);
    if (!connection) return;
    let reported: Extract<ConnectionState, { kind: "error" }>["code"] | undefined;
    let live: ChannelConnection;
    try {
      const credentials = given ?? (await this.credentials(connection));
      if (!credentials) {
        await this.drive(id, { kind: "failed", code: "credentials_missing" }, gen);
        return;
      }
      live = await this.channel(connection.platform).connect(credentials, {
        onMessage: (message) => {
          if (this.links.get(id)?.gen !== gen) return;
          try {
            this.receive(id, message);
          } catch (error) {
            this.log(`could not take a message from ${connection.platform}: ${(error as Error).message}`);
          }
        },
        onState: (state) => {
          if (state.kind === "error") reported = state.code;
          void this.drive(id, { kind: "reported", state }, gen);
        },
        onMembership: (change) => {
          if (this.links.get(id)?.gen !== gen) return;
          try {
            this.onMembership(id, change);
          } catch (error) {
            this.log(`could not take a membership change from ${connection.platform}: ${(error as Error).message}`);
          }
        },
      });
    } catch (error) {
      this.log(`${connection.platform} connection ${id} could not connect: ${(error as Error).message}`);
      await this.drive(id, { kind: "failed", ...(reported ? { code: reported } : {}) }, gen);
      return;
    }
    if (this.links.get(id)?.gen !== gen) {
      await live.close().catch(() => {});
      return;
    }
    this.live.set(id, live);
    this.store.updateConnection(id, { botId: live.bot.id, botName: live.bot.name });
    await this.drive(id, { kind: "opened" }, gen);
  }

  /** Credentials of every bot on this platform, across agents, newest connection first. */
  private async knownCredentials(platform: Platform): Promise<Credentials[]> {
    const found: Credentials[] = [];
    for (const connection of this.store
      .connections()
      .filter((c) => c.platform === platform)
      .reverse()) {
      const credentials = await this.credentials(connection).catch(() => undefined);
      if (credentials) found.push(credentials);
    }
    return found;
  }

  private async credentials(connection: Connection): Promise<Credentials | undefined> {
    // The private chat needs no secret: it only has to know which connection it is.
    if (this.isBuiltin(connection)) return { connection: connection.id };
    const raw = connection.secretRef ? await this.options.secrets.get(connection.secretRef) : undefined;
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Credentials;
    } catch {
      this.log(`connection ${connection.id}: stored credentials could not be read`);
      return undefined;
    }
  }

  private onMembership(connectionId: string, change: { chat: ChatRef; joined: boolean }): void {
    if (change.joined) {
      const chat = this.store.upsertChat({
        connectionId,
        platformId: change.chat.platformId,
        kind: change.chat.kind,
        name: change.chat.name,
      });
      this.roster(connectionId, chat.id, change.chat);
    }
  }

  /**
   * Read where someone sits in the organization (department, title) once per run, where the chat
   * app says and the owner turned member profiles on (docs/spec.md 4.2). One read at a time, in
   * the background, so a large group does not burst the platform's rate limit.
   */
  private learnProfile(connectionId: string, contact: Contact): void {
    const live = this.live.get(connectionId);
    if (!live?.profile || this.profiled.has(contact.id)) return;
    this.profiled.add(contact.id);
    this.profiling = this.profiling.then(async () => {
      const found = await live.profile?.(contact.platformId).catch(() => undefined);
      if (found !== undefined && found !== contact.profile) this.store.setContactProfile(contact.id, found);
    });
  }

  /**
   * Put a group's members in the address book, the way a person learns who is in a group they
   * joined: on joining, then again when the group is active and the list is older than a few hours.
   * Where the chat app can list members; best effort.
   */
  private roster(connectionId: string, chatId: string, ref: ChatRef): void {
    const live = this.live.get(connectionId);
    if (ref.kind === "dm" || !live?.capabilities().listMembers) return;
    const last = this.rostered.get(chatId);
    if (last !== undefined && Date.now() - last < ROSTER_TTL_MS) return;
    this.rostered.set(chatId, Date.now());
    void live
      .listMembers(ref)
      .then((members) => {
        for (const m of members) {
          if (!m.id || m.id === live.bot.id || m.id === live.bot.senderId) continue;
          // Other bots and agents too: agents work with each other, and @-mention each other by name.
          let contact = this.store.touchContact(connectionId, m.id, m.name);
          if (m.isBot && !contact.isBot) contact = this.store.setContactBot(contact.id, true) ?? contact;
          if (!contact.isBot) this.learnProfile(connectionId, contact);
        }
      })
      .catch((error) => this.log(`could not read the members of ${chatId}: ${(error as Error).message}`));
  }

  // ------------------------------------------------------------------- inbox

  /** The sender is one of this computer's agents, on a bot that is online now. */
  private isLocalBot(platform: Platform, senderId: string): boolean {
    for (const [id, live] of this.live) {
      if (this.store.connection(id)?.platform !== platform) continue;
      if (live.bot.id === senderId || live.bot.senderId === senderId) return true;
    }
    return false;
  }

  /**
   * Whoever a message @-mentions goes in the address book with the name the chat app shows, so the
   * agent can mention them back: "@Alex @Bob, talk it over" is how two agents meet (docs/spec.md 4.2).
   */
  private learnMentioned(connectionId: string, ownerId: string | null, inbound: InboundMessage): void {
    const live = this.live.get(connectionId);
    for (const other of inbound.mentions ?? []) {
      if (!other.id || other.id === live?.bot.id || other.id === live?.bot.senderId) continue;
      const contact = this.store.touchContact(connectionId, other.id, other.name);
      if (other.isBot && !contact.isBot && other.id !== ownerId) this.store.setContactBot(contact.id, true);
    }
  }

  /** One inbound message from a chat app (docs/spec.md 4.2, 4.3, 7.1). */
  receive(connectionId: string, inbound: InboundMessage): void {
    const connection = this.store.connection(connectionId);
    if (!connection) return;
    // A bot by the platform's word, or one of this computer's agents (a GitHub agent is a plain user account).
    const knownBot = inbound.sender.isBot || this.isLocalBot(connection.platform, inbound.sender.id);
    const parent = inbound.chat.parent
      ? this.store.upsertChat({
          connectionId,
          platformId: inbound.chat.parent.platformId,
          kind: "group",
          name: inbound.chat.parent.name,
        })
      : undefined;
    const chat = this.store.upsertChat({
      connectionId,
      platformId: inbound.chat.platformId,
      kind: inbound.chat.kind,
      name: inbound.chat.name,
      parentId: parent?.id,
      ...(inbound.chat.kind === "dm" ? { peerId: inbound.sender.id } : {}),
    });
    let contact = this.store.touchContact(connectionId, inbound.sender.id, inbound.sender.name);
    if (!connection.ownerId && chat.kind === "dm" && !knownBot && this.claim(connection, chat, contact, inbound))
      return;
    const ownerId = connection.ownerId;
    this.learnMentioned(connectionId, ownerId, inbound);
    const owner = inbound.sender.id === ownerId;
    if (knownBot && !owner && !contact.isBot) contact = this.store.setContactBot(contact.id, true) ?? contact;
    // The owner is a person, whatever was marked.
    const bot = !owner && contact.isBot;
    // A reply in a thread to a message in the chat it hangs off (a Feishu thread under the group's
    // message, docs/spec.md 4.13): the message it quotes is in the parent chat.
    const quoted = inbound.replyTo
      ? (this.store.messageByPlatformId(chat.id, inbound.replyTo) ??
        (parent ? this.store.messageByPlatformId(parent.id, inbound.replyTo) : undefined))
      : undefined;
    const replyTo = quoted?.id ?? null;
    // A message from before the bot joined is the group's past: kept for reading, never answered.
    const decision = inbound.earlier
      ? "background"
      : trigger({
          dm: chat.kind === "dm",
          bot,
          // A reply to something the agent said is addressed to it, even where the platform does not say so;
          // so is what people say next in a thread that is one conversation, once the agent spoke there.
          addressed:
            inbound.addressedToBot ||
            quoted?.direction === "out" ||
            (inbound.chat.followUp === true && this.store.lastSpokeAt(chat.id) !== undefined),
          mentioned: inbound.mentioned ?? (chat.kind !== "dm" && inbound.addressedToBot),
          hops: this.botHops.hops(chat.id),
        });
    const triggers = decision === "wake";
    // Who may put the agent to work (docs/spec.md 4.7). Only a trigger needs letting in: background
    // is stored as it always was.
    const group = chat.kind === "dm" ? undefined : (parent ?? chat);
    const verdict = triggers
      ? gate({
          trust: this.channel(connection.platform).trust ?? "public",
          askAll: this.store.agent(connection.agentId)?.askAll ?? false,
          isOwner: owner,
          chatKind: chat.kind,
          contact: contact.access ?? this.linkedAccess(contact),
          group: group?.access ?? null,
        })
      : "deliver";
    const message = this.store.insertInbound({
      chatId: chat.id,
      platformId: inbound.platformId,
      senderId: inbound.sender.id,
      senderName: inbound.sender.name,
      body: inbound.text,
      attachments: inbound.attachments.map((a) => ({
        ref: a.id,
        name: a.name,
        ...(a.size !== undefined ? { size: a.size } : {}),
        ...(a.mime ? { mime: a.mime } : {}),
      })),
      replyTo,
      // A refused person or group is kept on record, like background: it never wakes the agent.
      triggers: triggers && verdict !== "drop",
      held: verdict === "ask",
      createdAt: inbound.sentAt,
    });
    if (!message || inbound.earlier) return; // Delivered before, or the group's past.
    if (chat.kind !== "dm") this.roster(connectionId, chat.id, inbound.chat);
    if (!bot) this.learnProfile(connectionId, contact);
    if (!bot) this.botHops.person(chat.id);
    else if (triggers) this.botHops.woke(chat.id);
    else if (decision === "brake" && this.botHops.braked(chat.id)) {
      // Said once, without quoting or naming the bot as a mention: that would only wake it again.
      const name = contactName(contact) ?? inbound.sender.name;
      void this.outbox
        .send(connection.agentId, { chatId: chat.id, text: botBrakeNote(connection.platform, name), notice: true })
        .catch((error) => this.log(`bot brake note failed: ${(error as Error).message}`));
    }
    if (decision === "background" && !bot && (parent ?? chat).listen) {
      this.overhear(connection, chat, parent ?? chat, contact, owner, message);
    }
    if (!triggers || verdict === "drop") return; // Background, or someone the owner refused.
    if (verdict === "ask") {
      this.asked(connection, chat, group, contact, message);
      return;
    }
    // Let in without asking (or the owner speaking): remembered, so that turning on "ask about
    // everyone new" later does not cut off people already talking to the agent.
    if (chat.kind === "dm" && contact.access === null) this.store.setContactAccess(contact.id, "allowed");
    if (group && group.access === null) {
      this.store.setChatAccess(group.id, "allowed");
      // The owner using the agent in a group lets the group in: what waited there goes through too.
      if (owner) this.admit(connection.agentId, this.heldIn(connection.agentId, { group: group.id }));
    }

    const live = this.live.get(connectionId);

    if (this.paused.has(connection.agentId)) {
      // Not handed to the agent, and not kept for later: the person hears once per chat that it is paused.
      this.store.moveInbound([message.id], "pause");
      // The console says so itself, beside the private chat.
      if (this.pauseNoted.has(chat.id) || this.isBuiltin(connection)) return;
      this.pauseNoted.add(chat.id);
      const name = this.store.agent(connection.agentId)?.name ?? "";
      void this.outbox
        .send(connection.agentId, { chatId: chat.id, text: pausedNote(connection.platform, name), replyTo: message.id })
        .catch((error) => this.log(`paused note failed: ${(error as Error).message}`));
      return;
    }

    if (inbound.text.trim() === "/stop" && inbound.sender.id === ownerId) {
      this.store.moveInbound([message.id], "reply");
      for (const id of this.replies.openFor(connection.agentId)) this.replies.settle(id, "stopped");
      void this.stopAgent(connection.agentId).then((stopped) =>
        this.outbox
          .send(connection.agentId, {
            chatId: chat.id,
            text: stopNote(connection.platform, stopped),
            replyTo: message.id,
          })
          .catch((error) => this.log(`stop reply failed: ${(error as Error).message}`)),
      );
      return;
    }
    // Addressed: in a conversation with the agent, and heard at the usual pace again.
    if ((parent ?? chat).kind === "group") {
      // Track replies sent after this address so the first follow-up sees the agent's answer.
      if (!this.spokeSynced.has(chat.id)) this.spokeSynced.set(chat.id, this.store.lastSpokeAt(chat.id) ?? 0);
      this.book.addressed(chat.id, (parent ?? chat).id, inbound.sender.id, Date.now());
    }
    // Addressed where it chose to hear nothing: back to the usual pace, and it may choose again.
    const place = parent ?? chat;
    if (place.kind === "group" && place.listen && place.hearPace.kind === "muted") {
      this.store.setChatHearPace(place.id, { kind: "auto" });
      this.runtimes.get(connection.agentId)?.enqueueText(formatUnmuted(place.id));
      this.log(`${connection.agentId}: ${place.id} hears everything again, someone addressed the agent there`);
    }
    // A follow-up about work a line is doing goes straight to that line (docs/spec.md 4.13).
    const line = this.lineFor(connection.agentId, chat, quoted);
    if (line) {
      this.handToLine(line, message.id);
      return;
    }
    // Addressed now: the stretch it was about to hear comes with this message's `unseen` instead.
    this.unhear(chat.id);
    if (live) {
      this.replies.open({
        messageId: message.id,
        agentId: connection.agentId,
        platform: connection.platform,
        chat: inbound.chat,
        platformMessageId: inbound.platformId,
        senderId: inbound.sender.id,
        connection: live,
      });
    }
    this.runtimes.get(connection.agentId)?.enqueueMessage(message.id);
  }

  /**
   * A person spoke in a group that hears everything, not to the agent (docs/spec.md 4.2). Only
   * someone who could put it to work there starts a stretch: the group let in, the person not turned
   * away. Each new message pushes the stretch back until the group goes quiet, up to a limit.
   */
  private overhear(
    connection: Connection,
    chat: Chat,
    group: Chat,
    contact: Contact,
    owner: boolean,
    message: Message,
  ): void {
    if (this.stopping || this.paused.has(connection.agentId)) return;
    const verdict = gate({
      trust: this.channel(connection.platform).trust ?? "public",
      askAll: this.store.agent(connection.agentId)?.askAll ?? false,
      isOwner: owner,
      chatKind: chat.kind,
      contact: contact.access ?? this.linkedAccess(contact),
      group: group.access,
    });
    if (verdict !== "deliver") return;
    // The agent chose to hear nothing here until someone addresses it: kept as background only.
    if (group.hearPace.kind === "muted") return;
    const now = Date.now();
    this.syncSpoken(chat.id, group.id);
    const agent = this.store.agent(connection.agentId);
    const senderId = message.senderId ?? contact.platformId;
    const plan = this.book.observe({
      chatId: chat.id,
      groupId: group.id,
      senderId,
      at: message.createdAt,
      now,
      named: nameIn(message.body, [agent?.name, connection.botName, ...group.aliases]),
      owner,
      tier: this.tierOf(group, now),
      ...(group.hearPace.kind === "every" ? { everyMs: group.hearPace.ms } : {}),
      handling: this.runtimes.get(connection.agentId)?.handling(chat.id, senderId) ?? false,
    });
    const waiting = this.hearing.get(chat.id);
    // A line that rides along leaves the stretch's time as it was.
    if (waiting && !plan.reset) return;
    this.hearAt(connection.agentId, chat.id, plan.dueAt, now);
  }

  /** (Re)set the timer that hands a chat's stretch to the agent. */
  private hearAt(agentId: string, chatId: string, dueAt: number, now: number): void {
    const waiting = this.hearing.get(chatId);
    if (waiting) clearTimeout(waiting.timer);
    const timer = setTimeout(() => this.hear(chatId), Math.max(0, dueAt - now));
    timer.unref?.();
    this.hearing.set(chatId, { agentId, timer });
  }

  /** How fast a group keeps up with a conversation: the owner's choice, or else by its size. */
  private tierOf(group: Chat, now: number): HearTier {
    return group.hearTier ?? this.defaultTierOf(group, now);
  }

  /** The tier a group's size gives it: people who spoke there in the last week, counted once an hour. */
  private defaultTierOf(group: Chat, now: number): HearTier {
    let active = this.active.get(group.id);
    if (!active || now - active.at > ACTIVE_TTL_MS) {
      active = { n: this.store.activePeople(group.id, now - ACTIVE_WINDOW_MS), at: now };
      this.active.set(group.id, active);
    }
    return defaultTier(active.n);
  }

  /**
   * Tell `book` what the agent said in a chat since it was last told, and whom that answered
   * (docs/spec.md 4.2): read from what was sent, so any way of sending counts.
   */
  private syncSpoken(chatId: string, groupId: string): void {
    const after = this.spokeSynced.get(chatId);
    if (after === undefined) {
      // What it said before this chat was heard at all answers no stretch.
      this.spokeSynced.set(chatId, this.store.lastSpokeAt(chatId) ?? 0);
      return;
    }
    let last = after;
    for (const said of this.store.spokenSince(chatId, after)) {
      this.book.spoke(chatId, groupId, this.book.answered(chatId, said.quotedSender), said.createdAt);
      last = said.createdAt;
    }
    this.spokeSynced.set(chatId, last);
  }

  private pace(): { quietMs: number; maxWaitMs: number; gapMs: number } {
    return this.options.hearing ?? { quietMs: HEAR_QUIET_MS, maxWaitMs: HEAR_MAX_WAIT_MS, gapMs: HEAR_GAP_MS };
  }

  /** A group's pace as set, and the gap in force while unanswered stretches slowed it. */
  hearingView(group: Chat, now = Date.now()): HearingView {
    const base = {
      tier: group.hearTier,
      defaultTier: this.defaultTierOf(group, now),
      live: [] as string[],
      aliases: group.aliases,
    };
    if (group.hearPace.kind === "muted") return { pace: "muted", ...base };
    if (group.hearPace.kind === "every") return { pace: "every", everyMs: group.hearPace.ms, ...base };
    const live = this.book.live(group.id, now).map((id) => {
      const contact = this.store.contactByPlatformId(group.connectionId, id);
      return (contact && contactName(contact)) ?? contact?.name ?? id;
    });
    const gap = this.book.gap(group.id);
    return gap > this.pace().gapMs ? { pace: "auto", slowedMs: gap, ...base, live } : { pace: "auto", ...base, live };
  }

  /**
   * The owner picks how fast a group keeps up with a conversation (docs/spec.md 4.2): `save`,
   * `balanced` or `fast`, or null to follow the group's size. The owner's one knob on what it costs.
   */
  setHearTier(idOrSlug: string, chatId: string, tier: HearTier | null): HearingView {
    const agent = this.agent(idOrSlug);
    const chat = this.store.agentChat(agent.id, chatId);
    if (chat?.kind !== "group") throw notFound("chat", chatId);
    this.store.setChatHearTier(chat.id, tier);
    this.book.setTier(chat.id, tier ?? this.defaultTierOf(chat, Date.now()), Date.now());
    this.log(`${agent.name}: owner set ${chat.id} to keep up ${tier ?? "by its size"}`);
    return this.hearingView(this.store.chat(chat.id) ?? chat);
  }

  /** The owner adds or removes one name a group calls the agent by, on the list as it is now. */
  ownerAlias(idOrSlug: string, chatId: string, alias: string, add: boolean): HearingView {
    const agent = this.agent(idOrSlug);
    const chat = this.store.agentChat(agent.id, chatId);
    if (chat?.kind !== "group") throw notFound("chat", chatId);
    return this.hearingView(this.alias(agent.id, chat.id, alias, add).chat);
  }

  /**
   * The agent adds or removes a name the group calls it by (`chat alias`). A thread stands for its
   * group. It only helps a call be heard as one: what that costs stays within the owner's tier.
   */
  alias(agentId: string, chatId: string, alias: string, add: boolean): { chat: Chat; aliases: string[] } {
    const chat = this.store.agentChat(agentId, chatId);
    if (!chat || chat.kind === "dm") throw notFound("chat", chatId);
    const group = (chat.parentId ? this.store.chat(chat.parentId) : chat) ?? chat;
    const [name] = cleanAliases([alias], []);
    const key = (name ?? "").toLowerCase();
    const rest = group.aliases.filter((a) => a.toLowerCase() !== key);
    const next = add ? cleanAliases([...group.aliases, alias], this.ownNames(agentId, group)) : rest;
    this.store.setChatAliases(group.id, next);
    this.log(`${agentId}: ${add ? "added" : "removed"} the name "${name}" in ${group.id}`);
    return { chat: this.store.chat(group.id) ?? group, aliases: next };
  }

  /** The names a group calls the agent by anyway: its own and its bot's. */
  private ownNames(agentId: string, group: Chat): string[] {
    return [this.store.agent(agentId)?.name, this.store.connection(group.connectionId)?.botName].filter(
      (n): n is string => Boolean(n),
    );
  }

  /**
   * The agent sets how often a group that hears everything reaches it (docs/spec.md 4.2): at most
   * once per `everyMs`, nothing until someone addresses it there, or Mingle's own pace again. A
   * thread stands for its group. Only slower than Mingle's own pace, never faster: whoever asks it
   * to change this cannot make it spend more than the owner agreed to.
   */
  setHearPace(agentId: string, chatId: string, pace: HearPace): { chat: Chat; view: HearingView } {
    const chat = this.store.agentChat(agentId, chatId);
    if (!chat || chat.kind === "dm") throw notFound("chat", chatId);
    const group = chat.parentId ? this.store.chat(chat.parentId) : chat;
    if (!group?.listen) {
      throw new MingleError(
        "not_hearing",
        "this group reaches you only when someone @-mentions you or replies to you; only your owner can set it to hear everything",
        409,
      );
    }
    if (pace.kind === "every" && (pace.ms < HEAR_EVERY_MIN_MS || pace.ms > HEAR_EVERY_MAX_MS)) {
      throw new MingleError("every_out_of_range", "pick a gap from 2m to 7d; to hear nothing at all, use --mute");
    }
    this.store.setChatHearPace(group.id, pace);
    this.forgetHearing(agentId, group.id, pace.kind === "muted");
    const updated = this.store.chat(group.id) ?? group;
    this.log(
      `${agentId}: ${group.id} hears ${pace.kind === "every" ? `at most every ${pace.ms / 60_000} min` : pace.kind === "muted" ? "nothing until addressed" : "at the usual pace"}`,
    );
    return { chat: updated, view: this.hearingView(updated) };
  }

  /** The owner puts a group back on Mingle's own pace, whatever the agent set. */
  resetHearPace(idOrSlug: string, chatId: string): HearingView {
    const agent = this.agent(idOrSlug);
    const chat = this.store.agentChat(agent.id, chatId);
    if (chat?.kind !== "group") throw notFound("chat", chatId);
    this.store.setChatHearPace(chat.id, { kind: "auto" });
    this.forgetHearing(agent.id, chat.id, false);
    this.log(`${agent.name}: owner put ${chat.id} back on the usual pace`);
    return this.hearingView(this.store.chat(chat.id) ?? chat);
  }

  /**
   * A group's pace changed: the slowing from unanswered stretches ends, and muted drops what waits.
   * Otherwise what the group and its threads wait to hand over is timed again at the new pace, so a
   * stretch put off by a long `--every` does not keep waiting for it once the pace is shorter.
   */
  private forgetHearing(agentId: string, groupId: string, drop: boolean): void {
    const ids = [
      groupId,
      ...this.store
        .agentChats(agentId)
        .filter((c) => c.parentId === groupId)
        .map((c) => c.id),
    ];
    this.book.forget(ids, drop);
    if (drop) {
      for (const id of ids) this.unhear(id);
      return;
    }
    const pace = this.store.chat(groupId)?.hearPace;
    const everyMs = pace?.kind === "every" ? pace.ms : undefined;
    const now = Date.now();
    for (const id of ids) {
      const waiting = this.hearing.get(id);
      const dueAt = waiting ? this.book.retime(id, everyMs) : undefined;
      if (waiting && dueAt !== undefined) this.hearAt(waiting.agentId, id, dueAt, now);
    }
  }

  /** Drop the stretch a chat was waiting to hand over. */
  private unhear(chatId: string): void {
    this.book.drop(chatId);
    const waiting = this.hearing.get(chatId);
    if (!waiting) return;
    clearTimeout(waiting.timer);
    this.hearing.delete(chatId);
  }

  /**
   * Hand the agent what was said in the chat since the stretch began, as input it may answer or
   * leave be: no live reply, no reminder to answer, nothing for the owner (docs/spec.md 4.2).
   */
  private hear(chatId: string): void {
    const waiting = this.hearing.get(chatId);
    this.hearing.delete(chatId);
    if (!waiting) return;
    const chat = this.store.chat(chatId);
    const group = chat?.parentId ? this.store.chat(chat.parentId) : chat;
    const runtime = this.runtimes.get(waiting.agentId);
    // Turned off, muted, paused or gone meanwhile: nothing to hear.
    if (!chat || !group?.listen || group.hearPace.kind === "muted" || !runtime || this.paused.has(waiting.agentId)) {
      this.book.drop(chatId);
      return;
    }
    const now = Date.now();
    const handed = this.book.handOver(
      chatId,
      now,
      group.hearPace.kind === "every" ? group.hearPace.ms : undefined,
      (senderId) => runtime.handling(chatId, senderId),
    );
    if (!handed) return;
    // Fast, but the group's budget ran out meanwhile: it waits at the usual pace.
    if ("dueAt" in handed) {
      this.hearAt(waiting.agentId, chatId, handed.dueAt, now);
      return;
    }
    const { stretch } = handed;
    const spoke = this.store.lastSpokeAt(chat.id);
    // From the stretch's first line, not from when the agent last spoke: a line said while it was
    // still answering the previous stretch reaches it after, so it has not seen it. (The stretch
    // starts after the previous hand-over, and an @ or reply to it drops the stretch.)
    const from = stretch.from;
    // Those in a conversation with the agent are never the ones left out.
    const messages = this.store.backgroundFor(chat.id, from, stretch.engaged, HEAR_MESSAGES);
    const omitted = messages.length < HEAR_MESSAGES ? 0 : this.store.backgroundCount(chat.id, from) - messages.length;
    // The agent spoke after all of it, or only bots are left: nothing new from a person.
    const person = messages.some(
      (m) => !(m.senderId && this.store.contactByPlatformId(chat.connectionId, m.senderId)?.isBot),
    );
    if (!person) {
      this.book.cancel(stretch, now);
      return;
    }
    const cues = messages.filter(
      (m) =>
        !(m.senderId && stretch.engaged.has(m.senderId)) &&
        cueIn(m.body, {
          at: m.createdAt,
          ...(spoke !== undefined ? { agentSpokeAt: spoke } : {}),
          quotes: m.replyTo !== null,
        }),
    ).length;
    const live = stretch.lane === "fast" || stretch.lane === "steer" ? stretch.engaged : undefined;
    runtime.enqueueText(formatHeard(this.store, chat, messages, { omitted, ...(live ? { live } : {}) }), {
      track: this.timeStretch(waiting.agentId, chat.id, stretch, {
        count: messages.length + omitted,
        first: omitted > 0 ? from : (messages[0]?.createdAt ?? now),
        last: messages.reduce((at, m) => Math.max(at, m.createdAt), 0) || now,
        heard: now,
        cues,
      }),
      about: { chatId: chat.id, people: [...stretch.engaged] },
      steer: stretch.lane === "steer",
    });
  }

  /**
   * Where the time of a heard stretch went (docs/spec.md 4.2), logged once its turn ends: first and
   * last message, handed over, the turn starting, the agent speaking there. Only to the local log,
   * to tune the pace from what really happened.
   */
  private timeStretch(
    agentId: string,
    chatId: string,
    stretch: Stretch,
    s: { count: number; first: number; last: number; heard: number; cues: number },
  ): TextTrack {
    let turn: number | undefined;
    const secs = (at: number) => `+${Math.round((at - s.first) / 1000)}s`;
    return {
      delivered: (at) => {
        turn ??= at;
      },
      ended: (at) => {
        this.syncSpoken(chatId, stretch.groupId);
        const spoke = this.store.firstSpokeAt(chatId, s.heard);
        const lastSpoke = spoke === undefined ? undefined : this.store.lastSpokeAt(chatId);
        // Steered in as the turn was ending, and not answered: it may never have been read.
        if (stretch.lane === "steer" && spoke === undefined && this.book.late(turn ?? at, at)) {
          const group = this.store.chat(stretch.groupId);
          // Muted or turned off since it was steered in: it is not handed over again.
          const hearing = group?.listen === true && group.hearPace.kind !== "muted";
          const dueAt = hearing ? this.book.resend(stretch, Date.now()) : undefined;
          if (dueAt !== undefined && !this.paused.has(agentId)) {
            this.log(`${agentId}: heard ${chatId} steer: the turn ended ${secs(at)}, handing it over again`);
            this.hearAt(agentId, chatId, dueAt, Date.now());
            return;
          }
        }
        this.book.settle(stretch, spoke !== undefined, Date.now());
        const people = stretch.heard.size;
        this.log(
          `${agentId}: heard ${chatId} ${stretch.lane}: ${s.count} message${s.count === 1 ? "" : "s"} from ${people} ${people === 1 ? "person" : "people"} (${stretch.engaged.size} engaged), first +0s, last ${secs(s.last)}, handed over ${secs(s.heard)}, turn ${turn === undefined ? "?" : secs(turn)}, ${spoke === undefined ? "did not speak" : `spoke ${secs(spoke)}, last spoke ${secs(lastSpoke ?? spoke)}`}, cues ${s.cues}`,
        );
      },
    };
  }

  /**
   * The owner sets a group to hear everything, or only what is addressed to the agent (docs/spec.md
   * 4.2). Only where the chat app sends the bot every message in its groups. Turning it on lets the
   * group in, as the owner using the agent there would.
   */
  setListen(idOrSlug: string, chatId: string, listen: boolean): void {
    const agent = this.agent(idOrSlug);
    const chat = this.store.agentChat(agent.id, chatId);
    if (chat?.kind !== "group") throw notFound("chat", chatId);
    const connection = this.store.connection(chat.connectionId);
    if (listen && !(connection && this.channel(connection.platform).groupMessages)) {
      throw new MingleError("listen_unsupported", "this chat app only sends the bot what @-mentions it", 409);
    }
    if (listen && chat.access === null) this.setAccess(agent.id, { chat: chat.id }, "allowed");
    this.store.setChatListen(chat.id, listen);
    if (!listen) {
      // Whatever pace the agent set goes with it: turned on again, the group starts at the usual pace.
      this.store.setChatHearPace(chat.id, { kind: "auto" });
      this.forgetHearing(agent.id, chat.id, true);
    }
    this.log(`${agent.name}: owner set ${chat.id} to hear ${listen ? "everything" : "what is addressed to it"}`);
  }

  /**
   * A direct message to an ownerless bot that carries its claim code makes the sender the owner
   * (docs/spec.md 4.7). True when this message was that claim and is fully handled. A wrong code
   * counts against the bot's code, which stops working after a few, so it cannot be guessed.
   */
  private claim(connection: Connection, chat: Chat, contact: Contact, inbound: InboundMessage): boolean {
    const code = claimAttempt(inbound.text);
    if (!code || !connection.claimCode) return false;
    const valid = (connection.claimExpiresAt ?? 0) > Date.now();
    if (!valid || code !== connection.claimCode) {
      const misses = (this.claimMisses.get(connection.id) ?? 0) + 1;
      this.claimMisses.set(connection.id, misses);
      if (valid && misses >= CLAIM_ATTEMPTS) {
        this.store.updateConnection(connection.id, { claimCode: null, claimExpiresAt: null });
        this.log(
          `${connection.platform}: claim code of ${connection.botName ?? connection.id} retired after ${misses} wrong tries`,
        );
      }
      return false;
    }
    this.store.updateConnection(connection.id, { ownerId: inbound.sender.id, claimCode: null, claimExpiresAt: null });
    this.claimMisses.delete(connection.id);
    this.store.setContactAccess(contact.id, "allowed");
    this.log(
      `${connection.platform}: ${inbound.sender.name} claimed ${connection.botName ?? connection.id} as its owner`,
    );
    const message = this.store.insertInbound({
      chatId: chat.id,
      platformId: inbound.platformId,
      senderId: inbound.sender.id,
      senderName: inbound.sender.name,
      body: inbound.text,
      attachments: [],
      replyTo: null,
      triggers: true,
      createdAt: inbound.sentAt,
    });
    if (message) this.store.moveInbound([message.id], "reply");
    // What the new owner wrote before claiming waited as a stranger's; it goes through now.
    this.admit(connection.agentId, this.heldIn(connection.agentId, { contact }));
    const name = this.store.agent(connection.agentId)?.name ?? "";
    this.note(connection.id, chat, accessText(connection.platform).claimed(name), message?.id);
    return true;
  }

  /**
   * A message from a person or group the owner has not let in yet was held. The first time for that
   * person or group, the sender hears once that the agent asks first, and the owner is told in
   * their own chat with the bot. The console lists it under "Needs you" either way.
   */
  private asked(connection: Connection, chat: Chat, group: Chat | undefined, contact: Contact, message: Message): void {
    const held = this.heldIn(connection.agentId, group ? { group: group.id } : { contact });
    if (held.length !== 1) return;
    this.log(
      `${connection.platform}: holding a message from ${group ? `group ${group.id}` : `contact ${contact.id}`} for the owner`,
    );
    const text = accessText(connection.platform);
    this.note(connection.id, chat, text.askNote, message.id);
    const ownerId = connection.ownerId;
    if (!ownerId) return;
    const note = text.askOwner({
      agent: this.store.agent(connection.agentId)?.name ?? "",
      sender: contact.alias || contact.name,
      group: group ? (group.name ?? "") : null,
      body: message.body,
    });
    void this.messageOwner(connection.id, ownerId, note).catch((error) =>
      this.log(`owner notice failed: ${(error as Error).message}`),
    );
  }

  /**
   * A line of Mingle's own in a chat, like the greeting a new bot sends its owner. Kept with the chat
   * as a notice, so the console shows it, but not the agent's message: it answers nothing and does
   * not count as the agent's first reply (docs/spec.md 4.7). `replyTo` is the Mingle message it
   * quotes. Best effort.
   */
  private note(connectionId: string, chat: Chat, text: string, replyTo?: string): void {
    const agentId = this.store.connection(connectionId)?.agentId;
    if (!agentId || !this.live.has(connectionId)) return;
    void this.outbox
      .send(agentId, { chatId: chat.id, text, notice: true, ...(replyTo ? { replyTo } : {}) })
      .catch((error) => this.log(`note to ${chat.id} failed: ${(error as Error).message}`));
  }

  /** The other accounts the owner said belong to the same person as this one; none for an agent's link. */
  private ownerLinked(contact: Contact): Contact[] {
    if (!contact.personId || contact.linkedBy !== "owner") return [];
    return this.store.personContacts(contact.personId).filter((k) => k.id !== contact.id && k.linkedBy === "owner");
  }

  /** What the owner decided for this person on their other accounts, when not for this one: refused wins. */
  private linkedAccess(contact: Contact): "allowed" | "blocked" | null {
    const decided = this.ownerLinked(contact).map((k) => k.access);
    return decided.includes("blocked") ? "blocked" : decided.includes("allowed") ? "allowed" : null;
  }

  /** Held messages of one person's direct chats, or of one group and its threads. */
  private heldIn(agentId: string, of: { contact: Contact } | { group: string }): Message[] {
    return this.store
      .heldMessages(agentId)
      .filter((m) =>
        "group" in of
          ? m.chat.id === of.group || m.chat.parentId === of.group
          : m.chat.kind === "dm" && m.connectionId === of.contact.connectionId && m.senderId === of.contact.platformId,
      );
  }

  /** Held messages go to the agent in their order, as if they had just arrived. */
  private admit(agentId: string, messages: readonly Message[]): void {
    const moved = new Set(
      this.store.moveInbound(
        messages.map((m) => m.id),
        "admit",
      ),
    );
    if (moved.size === 0) return;
    // A paused agent does not take them later either, like anything else that came in meanwhile.
    if (this.paused.has(agentId)) {
      this.store.moveInbound([...moved], "pause");
      return;
    }
    for (const message of messages) {
      if (!moved.has(message.id)) continue;
      const chat = this.store.chat(message.chatId);
      const live = chat && this.live.get(chat.connectionId);
      if (live) this.reopenReply(agentId, message, live);
      this.runtimes.get(agentId)?.enqueueMessage(message.id);
    }
  }

  /**
   * The owner lets a person or a group put the agent to work, or turns them away (docs/spec.md 4.7).
   * What they sent meanwhile goes to the agent, or stays on record unanswered. Returns how many
   * held messages that settled. A bot's owner can always talk to the agent, so is not changed here.
   */
  setAccess(idOrSlug: string, target: { contact: string } | { chat: string }, access: "allowed" | "blocked"): number {
    const agent = this.agent(idOrSlug);
    let held: Message[];
    if ("contact" in target) {
      const contact = this.store.agentContact(agent.id, target.contact);
      if (!contact) throw notFound("contact", target.contact);
      if (this.store.connection(contact.connectionId)?.ownerId === contact.platformId) {
        throw new MingleError("contact_is_owner", "the bot's owner can always talk to the agent", 409);
      }
      // The owner said these accounts are one person: the answer is for all of them (docs/spec.md 4.7).
      // A link the agent made carries nothing, or a stranger could talk it into one.
      const accounts = [contact, ...this.ownerLinked(contact)];
      held = [];
      for (const account of accounts) {
        if (this.store.connection(account.connectionId)?.ownerId === account.platformId) continue;
        this.store.setContactAccess(account.id, access);
        held.push(...this.heldIn(agent.id, { contact: account }));
      }
    } else {
      const chat = this.store.agentChat(agent.id, target.chat);
      if (chat?.kind !== "group") throw notFound("chat", target.chat);
      this.store.setChatAccess(chat.id, access);
      held = this.heldIn(agent.id, { group: chat.id });
    }
    this.log(
      `${agent.name}: owner ${access === "allowed" ? "allowed" : "refused"} ${"contact" in target ? target.contact : target.chat}`,
    );
    if (access === "allowed") {
      this.admit(agent.id, held);
      return held.length;
    }
    return this.store.moveInbound(
      held.map((m) => m.id),
      "refuse",
    ).length;
  }

  /** Ask the owner about new people and groups on every chat app, not only public ones. */
  setAskAll(idOrSlug: string, on: boolean): void {
    this.store.setAskAll(this.agent(idOrSlug).id, on);
  }

  /** Switch the daily memory tidy-up (docs/spec.md 4.5) on or off for one agent. */
  setTidy(idOrSlug: string, on: boolean): void {
    this.store.setTidy(this.agent(idOrSlug).id, on);
  }

  /** Give each idle agent whose tidy-up is due its turn for it. Paused agents have no runtime. */
  tidyMemories(now = Date.now()): void {
    if (this.stopping) return;
    for (const runtime of this.runtimes.values()) runtime.tidyIfDue(now);
  }

  /**
   * The owner asks the agent to try again on messages it failed or did not answer
   * (all of them, or `ids`). Only messages whose chat app is online are retried: the
   * agent could not reply to the others anyway. Returns the IDs retried, and the connections
   * that were offline, so the console can say which bot to reconnect.
   */
  retryMessages(idOrSlug: string, ids?: readonly string[]): { retried: string[]; offline: string[] } {
    const agent = this.agent(idOrSlug);
    if (this.paused.has(agent.id)) {
      throw new MingleError("agent_paused", `${agent.name} is paused; resume it first`, 409);
    }
    const runtime = this.runtimes.get(agent.id);
    if (!runtime) return { retried: [], offline: [] };
    const retried: string[] = [];
    const offline = new Set<string>();
    for (const message of this.store.retryable(agent.id, ids)) {
      const chat = this.store.chat(message.chatId);
      const connection = chat && this.store.connection(chat.connectionId);
      const live = connection && this.live.get(connection.id);
      if (!chat || !connection) continue;
      if (!live) {
        offline.add(connection.id);
        continue;
      }
      if (this.store.moveInbound([message.id], "retry").length === 0) continue;
      retried.push(message.id);
      this.reopenReply(agent.id, message, live);
    }
    runtime.retry(retried);
    return { retried, offline: [...offline] };
  }

  /** A message going back to the agent shows progress again, like a new one. */
  private reopenReply(agentId: string, message: Message, live: ChannelConnection): void {
    const chat = this.store.chat(message.chatId);
    const connection = chat && this.store.connection(chat.connectionId);
    if (!chat || !connection || !message.platformId) return;
    this.replies.open({
      messageId: message.id,
      agentId,
      platform: connection.platform,
      chat: { platformId: chat.platformId, kind: chat.kind, ...(chat.name ? { name: chat.name } : {}) },
      platformMessageId: message.platformId,
      senderId: message.senderId ?? "",
      connection: live,
    });
  }

  /**
   * Deliver again the messages whose wait for a passing failure is over (docs/spec.md 4.3). One
   * whose chat app is offline keeps waiting: the agent could not reply there anyway; the next tick
   * after it reconnects picks it up.
   */
  resumeWaiting(now = Date.now()): void {
    const due = new Map<string, string[]>();
    const ready = this.store.dueWaiting(now);
    for (const message of ready) {
      const runtime = this.runtimes.get(message.agentId);
      // A runtime whose session still runs on a scope its configuration just left is skipped:
      // its deferred refresh is what may deliver the newly-ready retry, never the old session.
      if (!runtime || this.paused.has(message.agentId) || runtime.signIn !== this.signIn(message.agentId)) continue;
      const chat = this.store.chat(message.chatId);
      const live = chat && this.live.get(chat.connectionId);
      if (!live) continue;
      if (this.store.moveInbound([message.id], "resume").length === 0) continue;
      this.reopenReply(message.agentId, message, live);
      due.set(message.agentId, [...(due.get(message.agentId) ?? []), message.id]);
    }
    for (const [agentId, ids] of due) {
      this.log(`${agentId}: trying again on ${ids.join(",")} after waiting`);
      this.runtimes.get(agentId)?.resume(ids, now);
    }
  }

  /** Dismiss selected failed or unanswered inbound messages without waking the agent or sending a reply. */
  ignoreMessages(idOrSlug: string, ids: readonly string[]): string[] {
    const agent = this.agent(idOrSlug);
    return this.store.moveInbound(
      this.store.retryable(agent.id, ids).map((message) => message.id),
      "ignore",
    );
  }

  // --------------------------------------------------------------- reminders

  fireReminders(now = Date.now()): void {
    if (this.stopping) return;
    for (const reminder of this.store.dueReminders(now)) {
      try {
        if (reminder.check) this.startCheck(reminder, now);
        else this.fireReminder(reminder, now);
      } catch (error) {
        this.log(`reminder ${reminder.id} failed to fire: ${(error as Error).message}`);
      }
    }
  }

  private fireReminder(reminder: Reminder, now: number): void {
    let next: number | null = null;
    if (reminder.rule !== "once") {
      try {
        next = nextFire(reminder.rule, now);
      } catch {
        next = null;
      }
    }
    this.store.markReminderFired(reminder.id, now, next);
    const runtime = this.runtimes.get(reminder.agentId);
    if (!runtime) {
      // A paused or deleted agent has no runtime: the reminder fired but goes nowhere.
      this.log(`reminder ${reminder.id} fired but agent ${reminder.agentId} has no runtime`);
      return;
    }
    runtime.enqueueText(formatReminder(reminder, now, this.reminderQuote(reminder)));
  }

  /**
   * Runs a reminder's check command for an agent: in its home, with a fixed allowlist of Mingle's
   * own variables (`checkEnvironment`) — never the agent's secret variables and never arbitrary
   * `process.env`, so the command cannot speak as the agent or be handed credentials by accident.
   */
  async runCheck(agentId: string, command: string, signal?: AbortSignal): Promise<CheckOutcome> {
    const agent = this.store.agent(agentId);
    if (!agent) throw notFound("agent", agentId);
    const result = await runCommand(command, {
      cwd: this.homeDir(agent),
      env: checkEnvironment(),
      timeoutMs: CHECK_TIMEOUT_MS,
      maxOutputBytes: CHECK_MAX_OUTPUT,
      ...(signal ? { signal } : {}),
    });
    return outcome(result);
  }

  /**
   * The one-shot run `reminder set --check` does before the reminder exists. Tracked like a
   * scheduled check: pausing or deleting the agent, or shutting Mingle down, cancels it, and a
   * cancelled probe always fails, so a reminder is never registered from a run that was let go —
   * even if the agent was resumed while it ran.
   */
  probeCheck(agentId: string, command: string): Promise<CheckOutcome> {
    if (this.stopping || this.paused.has(agentId) || this.deleting.has(agentId) || !this.store.agent(agentId)) {
      return Promise.resolve({ ok: false, error: "was cancelled" });
    }
    const key = `probe:${agentId}:${++this.probeSeq}`;
    const controller = new AbortController();
    const run = this.runCheck(agentId, command, controller.signal)
      .catch((): CheckOutcome => ({ ok: false, error: "could not run" }))
      // A pause, delete or shutdown that landed while it ran voids the result: the caller must
      // not register a reminder from a run that was let go, even across a fast resume.
      .then((result): CheckOutcome => {
        if (controller.signal.aborted || this.stopping || this.paused.has(agentId) || this.deleting.has(agentId)) {
          return { ok: false, error: "was cancelled" };
        }
        return result;
      })
      .finally(() => this.checking.delete(key));
    this.checking.set(key, { agentId, controller, run: run.then(() => {}) });
    return run;
  }

  /** Every check now running has finished. For tests. */
  async checksSettled(): Promise<void> {
    while (this.checking.size > 0) await Promise.all([...this.checking.values()].map((op) => op.run));
  }

  /**
   * Lets go of check commands still running: the one for `reminderId`, or all of the agent's —
   * scheduled checks and set-up probes — when the agent pauses, is deleted or Mingle stops. The
   * result a cancelled run lands with is dropped in finishCheck / fails the probe.
   */
  abortCheck(agentId: string, reminderId?: string): void {
    for (const [key, op] of this.checking) {
      if (op.agentId !== agentId) continue;
      if (reminderId !== undefined && key !== reminderId) continue;
      op.controller.abort();
    }
  }

  /** The message a reminder was set for, quoted the same way a plain fire quotes it. */
  private reminderQuote(reminder: Reminder): string | undefined {
    const source = reminder.sourceMessageId ? this.store.message(reminder.sourceMessageId) : undefined;
    const agentName = this.store.agent(reminder.agentId)?.name;
    const quoted = source && renderMessage(this.store, source, agentName ? { agentName } : {});
    return quoted || undefined;
  }

  /**
   * A check came due: its next time is written first, then it runs in the background. One still
   * running from last time is left to finish rather than started twice — unless its time is up,
   * which ends the reminder and lets the running check go.
   */
  private startCheck(reminder: Reminder, now: number): void {
    if (this.stopping || this.paused.has(reminder.agentId) || this.deleting.has(reminder.agentId)) return;
    const check = reminder.check as NonNullable<Reminder["check"]>;
    if (check.until !== null && now >= check.until) {
      // Its time is up: it ends, and the agent hears once, so whoever was waiting is not left hanging.
      this.abortCheck(reminder.agentId, reminder.id);
      this.store.markReminderFired(reminder.id, now, null);
      const runtime = this.runtimes.get(reminder.agentId);
      if (!runtime) return;
      runtime.enqueueText(
        formatReminder(reminder, now, this.reminderQuote(reminder), {
          state: "expired",
          text: expiredText(reminder.id),
        }),
      );
      return;
    }
    if (this.checking.has(reminder.id)) return;
    let next: number | null = null;
    try {
      next = nextFire(reminder.rule, now);
    } catch {
      next = null;
    }
    this.store.markReminderDue(reminder.id, next);
    const command = check.command;
    const controller = new AbortController();
    const run = this.runCheck(reminder.agentId, command, controller.signal)
      .catch((): CheckOutcome => ({ ok: false, error: "could not run" }))
      .then((result) => this.finishCheck(reminder.agentId, reminder.id, result, Date.now(), controller.signal))
      .catch((error) => this.log(`reminder ${reminder.id} check failed: ${(error as Error).message}`))
      .finally(() => this.checking.delete(reminder.id));
    this.checking.set(reminder.id, { agentId: reminder.agentId, controller, run });
  }

  /**
   * A check finished. The reminder is read again: cancelled, paused or expired meanwhile, the
   * result is dropped. A changed output fires it; an agent that cannot hear it now keeps the old
   * baseline, so the next check finds the change again.
   */
  private finishCheck(
    agentId: string,
    reminderId: string,
    result: CheckOutcome,
    at: number,
    signal: AbortSignal,
  ): void {
    if (signal.aborted || this.paused.has(agentId) || this.stopping || this.deleting.has(agentId)) return;
    const reminder = this.store.reminder(agentId, reminderId);
    if (!reminder?.check) return;
    const check = reminder.check;
    // Past its deadline between two ticks, a change is no news: the deadline ends it, not this.
    if (check.until !== null && at >= check.until) return;
    const runtime = this.runtimes.get(agentId);
    if (!result.ok) {
      const failures = this.store.recordCheckFailure(reminder.id, at, result.error);
      this.log(`reminder ${reminder.id} check failed (${failures} in a row)`);
      if (failures === CHECK_FAILURES_TOLD && runtime) {
        runtime.enqueueText(
          formatReminder(reminder, at, this.reminderQuote(reminder), {
            state: "failing",
            text: failingText(failures, result.error, reminder.id),
          }),
        );
      }
      return;
    }
    if (result.hash === check.hash || !runtime) {
      this.store.recordCheck(reminder.id, at, { ...result, fired: false, ended: false });
      return;
    }
    this.store.recordCheck(reminder.id, at, { ...result, fired: true, ended: check.once });
    runtime.enqueueText(
      formatReminder(reminder, at, this.reminderQuote(reminder), {
        state: "changed",
        text: changedText(result.output),
      }),
    );
  }

  /**
   * The owner cancels a reminder from the console (docs/spec.md 4.6). It never fires again, paused
   * or not, and the agent hears it with its next input so it does not set the reminder again.
   */
  cancelReminder(idOrSlug: string, reminderId: string): void {
    const agent = this.agent(idOrSlug);
    const reminder = this.store.reminder(agent.id, reminderId);
    // A one-off that already fired is no longer listed: nothing is left to cancel.
    if (!reminder || reminder.nextFireAt === null || !this.store.deleteReminder(agent.id, reminderId))
      throw notFound("reminder", reminderId);
    this.abortCheck(agent.id, reminderId);
    this.store.addOwnerNote(
      agent.id,
      `[mingle] The owner cancelled reminder ${reminder.id} (${quoteNote(reminder.body)}) in the console. It will not fire again; don't set it again unless asked.`,
    );
    this.log(`${agent.name}: owner cancelled reminder ${reminder.id}`);
  }

  /**
   * The owner closes an open task from the console (docs/spec.md 4.6). False when it was already
   * done or closed. The agent hears it with its next input.
   */
  closeTask(idOrSlug: string, taskId: string): boolean {
    const agent = this.agent(idOrSlug);
    const task = this.store.task(agent.id, taskId);
    if (!task) throw notFound("task", taskId);
    if (task.lineState && task.lineState !== "ended") void this.lines.end(task.id);
    if (task.status === "done" || task.status === "closed")
      return Boolean(task.lineState && task.lineState !== "ended");
    this.store.setTaskStatus(agent.id, task.id, "closed");
    this.store.addOwnerNote(
      agent.id,
      `[mingle] The owner closed task ${task.id} (${quoteNote(task.title)}) in the console. Stop working on it.`,
    );
    this.log(`${agent.name}: owner closed task ${task.id}`);
    return true;
  }

  // ------------------------------------------------------------------- lines

  /** The line a message about earlier work belongs to: by what it replies to, or the thread it is in. */
  private lineFor(agentId: string, chat: Chat, quoted: Message | undefined) {
    const task =
      (quoted ? this.store.lineOfMessage(agentId, quoted.id) : undefined) ??
      (chat.kind === "thread" ? this.store.lineOfChat(agentId, chat.id) : undefined);
    return task && task.status !== "closed" && task.lineState !== "ended" ? task : undefined;
  }

  /**
   * What a line reads first, after its brief: the message it works for and the messages before it in
   * that chat (at most `LINE_SOURCE_BEFORE`), as the agent would have seen them.
   */
  private lineSource(task: Task): string {
    const message = task.fromMessage ? this.store.message(task.fromMessage) : undefined;
    const agent = this.store.agent(task.agentId);
    if (!message || !agent) return "";
    const render = (m: Message) => renderMessage(this.store, m, { agentName: agent.name });
    const before = this.store.chatMessages(message.chatId, LINE_SOURCE_BEFORE, message.id).map(render).filter(Boolean);
    const parts = [`The message this work is for:\n${render(message)}`];
    if (before.length) parts.unshift(`What was said before it in that chat, oldest first:\n${before.join("\n")}`);
    parts.push(`For more, read the chat: "$MINGLE_CLI" message read ${message.chatId} --around ${message.id}`);
    parts.push(this.lineWhere(task));
    return parts.join("\n\n");
  }

  /** Where the line talks about its work (docs/spec.md 4.13): its thread, one about to open, or nowhere. */
  private lineWhere(task: Task): string {
    if (task.threadChat)
      return `[mingle] This work has a thread: ${task.threadChat}. "message send" goes there; talk there as the work goes, and reply to ${task.fromMessage} only with the result.`;
    return this.canOpenThread(task)
      ? `[mingle] Your first "message send" opens a thread under ${task.fromMessage} for this work; talk there as the work goes, and reply to ${task.fromMessage} only with the result.`
      : '[mingle] This chat has no threads: do not post progress in it. Say how far you are with "$MINGLE_CLI" task status instead; message send only to ask the person something.';
  }

  /** A reply to the message this work is for can open a thread under it (docs/spec.md 4.13). */
  canOpenThread(task: Task): boolean {
    if (task.threadChat) return false;
    const chat = task.fromChat ? this.store.chat(task.fromChat) : undefined;
    return Boolean(chat?.kind === "group" && this.live.get(chat.connectionId)?.capabilities().threads);
  }

  /** What was said in the line's thread lately, for a line that starts its conversation over. */
  private lineThread(task: Task): string {
    const agent = this.store.agent(task.agentId);
    if (!task.threadChat || !agent) return "";
    const said = this.store
      .chatMessages(task.threadChat, LINE_THREAD_RECENT)
      .map((m) => renderMessage(this.store, m, { agentName: agent.name }))
      .filter(Boolean);
    return said.length ? `What was said in this work's thread lately, oldest first:\n${said.join("\n")}` : "";
  }

  /** Hand a message to a task's line, waking it; finished work picks up again. */
  private handToLine(task: Task, messageId: string): void {
    this.store.setMessageLine(messageId, task.id);
    this.store.moveInbound([messageId], "deliver");
    if (task.status === "done" || task.status === "todo")
      this.store.setTaskStatus(task.agentId, task.id, "in_progress");
    const message = this.store.message(messageId);
    const agent = this.store.agent(task.agentId);
    if (!message || !agent) return;
    this.log(`${agent.name}: ${messageId} goes to the line of ${task.id} (${message.body.slice(0, 40)})`);
    this.lines.wake(task.id, renderMessage(this.store, message, { agentName: agent.name }), message.id);
  }

  /** The agent starts a line for work that takes a while (docs/spec.md 4.13). */
  runTask(agentId: string, input: { title: string; from: string; brief: string }): Task {
    const message = this.store.agentMessage(agentId, input.from);
    if (!message) throw notFound("message", input.from);
    // One message, one line: a second would answer the same person beside the first, as the same agent.
    const running = this.store.lineFromMessage(agentId, message.id);
    if (running)
      throw new MingleError(
        "already_running",
        `${running.id} already works on ${message.id} ("${running.title}"); pass what is new on with: task tell ${running.id} --from ${message.id}`,
        409,
      );
    // Asked in a thread already (a Slack thread, a Discord thread, a document comment): the work happens there.
    const chat = this.store.chat(message.chatId);
    const task = this.store.createLineTask({
      agentId,
      title: input.title,
      fromMessage: message.id,
      fromChat: message.chatId,
      brief: input.brief,
      threadChat: chat?.kind === "thread" ? chat.id : null,
    });
    this.log(`${this.store.agent(agentId)?.name ?? agentId}: line ${task.id} for ${message.id}`);
    this.lines.start(task);
    return this.store.task(agentId, task.id) as Task;
  }

  /** The main session passes something on to a line: a message about its work, a note, or both. */
  tellTask(agentId: string, taskId: string, input: { text?: string; from?: string }): Task {
    const task = this.store.task(agentId, taskId);
    if (!task?.lineState || task.lineState === "ended" || task.status === "closed") throw notFound("task", taskId);
    const agent = this.agent(agentId);
    const parts: string[] = [];
    if (input.text?.trim()) parts.push(`[mingle] Your main session passes this on:\n${input.text.trim()}`);
    if (input.from) {
      const message = this.store.agentMessage(agentId, input.from);
      if (!message) throw notFound("message", input.from);
      // The line answers it now; the main session is not asked to.
      this.store.setMessageLine(message.id, task.id);
      parts.push(renderMessage(this.store, message, { agentName: agent.name }));
    }
    if (!parts.length)
      throw new MingleError("tell_empty", "pass --from <message-id>, a note on standard input, or both");
    if (task.status !== "in_progress") this.store.setTaskStatus(agentId, task.id, "in_progress");
    this.lines.wake(task.id, parts.join("\n\n"));
    return this.store.task(agentId, task.id) as Task;
  }

  /**
   * Something went out about a line's work (docs/spec.md 4.13): the thread it opened is where the
   * work goes on, and what the line said there is how far it is.
   */
  lineSpoke(taskId: string, report: SendReport, how: { progress: boolean }): void {
    const task = this.store.taskById(taskId);
    if (!task) return;
    if (report.thread && !task.threadChat) {
      this.store.updateLine(task.id, { threadChat: report.thread });
      this.log(`line ${task.id}: talks in thread ${report.thread}`);
    }
    const said = report.messages[0]?.body;
    if (how.progress && said) this.store.updateLine(task.id, { progress: firstLine(said) });
  }

  /** A line says how far it is, where it has no thread to say it in: the console shows it. */
  taskProgress(agentId: string, taskId: string, text: string): Task {
    const task = this.store.task(agentId, taskId);
    if (!task) throw notFound("task", taskId);
    this.store.updateLine(task.id, { progress: firstLine(text) });
    return this.store.task(agentId, task.id) as Task;
  }

  /**
   * The agent sets a task's status. Closing a task whose line is still on it stops the line, as the
   * console's "stop" does: someone said to drop it, so nothing more should arrive in the chat.
   */
  setTaskStatus(agentId: string, taskId: string, status: TaskStatus, byLine = false): Task {
    const before = this.store.task(agentId, taskId);
    if (!before) throw notFound("task", taskId);
    if (byLine) {
      // Told to stop in its thread: it said where it got to and stops after this turn, not mid-command.
      this.lines.release(before.id);
      this.store.addOwnerNote(
        agentId,
        `[mingle] Task ${before.id} (${quoteNote(before.title)}) was stopped: someone asked its line to stop, and it said in the chat how far it got.`,
      );
      this.log(`${this.store.agent(agentId)?.name ?? agentId}: line ${before.id} closed its task when told to stop`);
    } else if (status === "closed" && before.lineState && before.lineState !== "ended") {
      void this.lines.end(before.id);
      this.log(`${this.store.agent(agentId)?.name ?? agentId}: closed task ${before.id}; its line stops`);
    }
    return this.store.setTaskStatus(agentId, before.id, status) as Task;
  }

  /** A line finished its task: the summary reaches the main session with its next input. */
  doneTask(agentId: string, taskId: string, summary: string): Task {
    const task = this.store.task(agentId, taskId);
    if (!task) throw notFound("task", taskId);
    const text = summary.trim();
    this.store.setTaskStatus(agentId, task.id, "done");
    if (text) this.store.updateLine(task.id, { summary: text.slice(0, 4000) });
    this.store.addOwnerNote(
      agentId,
      `[mingle] Task ${task.id} ("${task.title}") is done; your line already answered in the chat.${text ? ` Its summary:\n${text.slice(0, 2000)}` : ""}\nWrite into MEMORY.md and notes/ what you will need later.`,
    );
    return this.store.task(agentId, task.id) as Task;
  }

  // ---------------------------------------------------------------- handoffs

  /**
   * Hand the agent what another conversation knows (docs/spec.md 4.12). It reaches the agent as an
   * input of its own: now when idle, after the current turn when busy, on resume when paused.
   */
  handoff(
    idOrSlug: string,
    body: unknown,
    via: Handoff["via"],
  ): { handoff: Handoff; name: string; state: "idle" | "busy" | "paused" } {
    const agent = this.agent(idOrSlug);
    const handoff = this.store.addHandoff(agent.id, checkHandoff(body), via);
    const runtime = this.runtimes.get(agent.id);
    runtime?.enqueueHandoff(handoff.id);
    this.log(`${agent.name}: handoff ${handoff.id} (${via}, ${Buffer.byteLength(handoff.body, "utf8")} bytes)`);
    return {
      handoff,
      name: agent.name,
      state: this.paused.has(agent.id) || !runtime ? "paused" : runtime.busy ? "busy" : "idle",
    };
  }

  handoffs(idOrSlug: string, limit = 30): Handoff[] {
    return this.store.handoffs(this.agent(idOrSlug).id, limit);
  }

  /** What the owner gives the other conversation, with this computer's CLI path in the command. */
  handoffPrompt(idOrSlug: string): string {
    const agent = this.agent(idOrSlug);
    return handoffPrompt(agent, readRole(this.homeDir(agent)), this.cliPath);
  }

  // --------------------------------------------------------------------- cli

  private writeCliWrapper(): void {
    const script =
      process.platform === "win32"
        ? `@echo off\r\n"${process.execPath}" "${this.options.cliEntry}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${this.options.cliEntry}" "$@"\n`;
    writeFileSync(this.cliPath, script);
    chmodSync(this.cliPath, 0o755);
  }
}

/** A picture is at most this big; the console sends a 256 px square, far below it. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_FILE = /^[A-Za-z0-9_-]+\.(?:png|jpg|webp)$/;

/** The image format from its first bytes, so a file is never trusted by its name or a header. */
function imageType(bytes: Uint8Array): "png" | "jpg" | "webp" | undefined {
  const starts = (sig: readonly number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts([0xff, 0xd8, 0xff])) return "jpg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  return undefined;
}

/** A line's progress as the console shows it: the first line of what it said, at most 120 characters. */
function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** A reminder or task in an owner note: one line, short enough to recognise. */
function quoteNote(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return JSON.stringify(line.length > 80 ? `${line.slice(0, 79)}…` : line);
}
