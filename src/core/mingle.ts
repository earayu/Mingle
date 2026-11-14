import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  Platform,
} from "../channels/channel.ts";
import type { Harness, HarnessInfo, HarnessStatus } from "../harness/harness.ts";
import type { SecretStore } from "../platform/secrets.ts";
import { type Agent, type Connection, type Message, type Reminder, Store } from "../store/store.ts";
import { VERSION } from "../version.ts";
import { Brains } from "./brains.ts";
import { checkEnvName, checkEnvValue, decodeEnvValue, encodeEnvValue, envRef } from "./env.ts";
import { MingleError, notFound } from "./errors.ts";
import { formatReminder, renderMessage } from "./format.ts";
import { createHome, memorySize, writeRole } from "./home.ts";
import { slugify } from "./ids.ts";
import { BACKOFF_MS, type LinkEffect, type LinkEvent, type LinkState, step, stored } from "./link.ts";
import { LiveReplies, pausedNote, stopNote } from "./live.ts";
import { Outbox } from "./outbox.ts";
import type { Paths } from "./paths.ts";
import { AgentRuntime, type FailureInfo } from "./runtime.ts";
import { nextFire } from "./schedule.ts";

export interface OnboardingSession {
  readonly id: string;
  readonly agentId: string;
  readonly platform: Platform;
  state:
    | { kind: "starting" }
    | { kind: "qr"; content: string; expiresAt: number }
    | { kind: "scanned" }
    | { kind: "awaiting_approval" }
    | { kind: "needs_code"; retry: boolean }
    | { kind: "done"; connectionId: string; pendingApproval: boolean }
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

export interface MingleOptions {
  readonly paths: Paths;
  readonly harness: Harness;
  readonly channels: Partial<Record<Platform, Channel>>;
  readonly secrets: SecretStore;
  /** Absolute path of the CLI entry script, run with this Node binary. */
  readonly cliEntry: string;
  readonly coalesceMs?: number;
  readonly reminderTickMs?: number;
  /** How often to look for a jump of the clock, the sign that the computer slept. */
  readonly wakeCheckMs?: number;
  readonly retryDelaysMs?: readonly number[];
  /** Waits between automatic reconnect attempts of a bot that went offline. */
  readonly reconnectDelaysMs?: readonly number[];
  readonly log?: (line: string) => void;
}

/** The whole local process: store, agent runtimes, live IM connections, reminders. The HTTP API sits on top. */
/** Variables that give an agent a sign-in of its own, so it does not share the computer's usage limit. */
const OWN_SIGN_IN = /(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|BASE_URL|CONFIG_DIR|_HOME)$/;

export class Mingle {
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
  private reminderTimer: NodeJS.Timeout | undefined;
  private wakeTimer: NodeJS.Timeout | undefined;
  private resuming: Promise<void> | undefined;
  private readonly onboardings = new Map<string, OnboardingSession>();
  /** Paused agents (docs/spec.md 4.11), and the chats already told so during the current pause. */
  private readonly paused = new Set<string>();
  private readonly pauseNoted = new Set<string>();
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

  readonly options: MingleOptions;

  constructor(options: MingleOptions) {
    this.options = options;
    for (const dir of [options.paths.home, options.paths.agents, options.paths.bin, options.paths.logs]) {
      mkdirSync(dir, { recursive: true });
    }
    this.store = new Store(options.paths.db);
    this.replies = new LiveReplies((line) => this.log(line));
    this.outbox = new Outbox(this.store, (id) => this.live.get(id), options.retryDelaysMs, this.replies);
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
    for (const agent of this.store.agents()) {
      // A paused agent stays paused across restarts: no session, no token, until the owner resumes it.
      if (agent.status === "paused") this.paused.add(agent.id);
      else this.addRuntime(agent).start();
    }
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

  async stop(): Promise<void> {
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
    for (const connection of this.store.connections(agent.id)) await this.removeConnection(connection.id);
    for (const { name } of this.store.envNames(agent.id)) {
      await this.options.secrets.delete(envRef(agent.id, name)).catch(() => {});
    }
    await this.runtimes.get(agent.id)?.dispose();
    await this.closing.get(agent.id);
    this.runtimes.delete(agent.id);
    this.revokeTokens(agent.id);
    this.paused.delete(agent.id);
    this.store.deleteAgent(agent.id);
    if (removeHome) rmSync(this.homeDir(agent), { recursive: true, force: true });
  }

  async stopAgent(idOrSlug: string): Promise<boolean> {
    const agent = this.agent(idOrSlug);
    return (await this.runtimes.get(agent.id)?.stop()) ?? false;
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
    const states = ["received", "delivered", "waiting", "replied", "unanswered", "failed", "ignored"];
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
    // A background job of the old session must not speak for it any more.
    this.revokeTokens(agent.id);
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
    this.fireReminders();
    this.log(`${agent.name} resumed`);
    return true;
  }

  private revokeTokens(agentId: string): void {
    for (const [token, id] of this.tokens) if (id === agentId) this.tokens.delete(token);
  }

  /** The agent a CLI token belongs to. */
  agentForToken(token: string): Agent | undefined {
    const id = this.tokens.get(token);
    return id ? this.store.agent(id) : undefined;
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
    return Boolean(this.options.channels[platform]);
  }

  channel(platform: Platform): Channel {
    const channel = this.options.channels[platform];
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

  /** Start a QR (or other multi-step) onboarding the console follows by polling `onboarding(id)`. */
  startOnboarding(agentId: string, platform: Platform): OnboardingSession {
    const agent = this.agent(agentId);
    const channel = this.channel(platform);
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
        for await (const event of channel.onboard(undefined, abort.signal, {
          agentName: agent.name,
          awaitCode,
          knownCredentials,
        })) {
          if (event.kind === "qr_ready") set({ kind: "qr", content: event.qrContent, expiresAt: event.expiresAt });
          else if (event.kind === "scanned") set({ kind: "scanned" });
          else if (event.kind === "awaiting_approval") set({ kind: "awaiting_approval" });
          else if (event.kind === "needs_code") set({ kind: "needs_code", retry: Boolean(event.retry) });
          else if (event.kind === "failed") set({ kind: "failed", code: event.code });
          else if (event.kind === "succeeded") {
            const connection = await this.finishOnboarding(agent.id, platform, event);
            set({ kind: "done", connectionId: connection.id, pendingApproval: Boolean(event.pendingApproval) });
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
    await live.messageUser(ownerId, text).catch((error) => this.log(`greeting failed: ${(error as Error).message}`));
  }

  async removeConnection(connectionId: string): Promise<void> {
    const connection = this.store.connection(connectionId);
    if (!connection) return;
    this.drive(connectionId, { kind: "remove" });
    this.links.delete(connectionId);
    if (connection.secretRef) await this.options.secrets.delete(connection.secretRef);
    this.store.deleteConnection(connectionId);
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
      this.store.upsertChat({
        connectionId,
        platformId: change.chat.platformId,
        kind: change.chat.kind,
        name: change.chat.name,
      });
    }
  }

  // ------------------------------------------------------------------- inbox

  /** One inbound message from a chat app (docs/spec.md 4.2, 4.3, 7.1). */
  receive(connectionId: string, inbound: InboundMessage): void {
    const connection = this.store.connection(connectionId);
    if (!connection) return;
    // Other bots are ignored until there are rules against bot-to-bot loops (docs/spec.md 13).
    if (inbound.sender.isBot) return;
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
    });
    let ownerId = connection.ownerId;
    if (!ownerId && chat.kind === "dm") {
      ownerId = inbound.sender.id;
      this.store.updateConnection(connectionId, { ownerId });
      this.log(
        `${connection.platform}: ${inbound.sender.name} is now the owner of ${connection.botName ?? connection.id}`,
      );
    }
    this.store.touchContact(connectionId, inbound.sender.id, inbound.sender.name);
    const quoted = inbound.replyTo ? this.store.messageByPlatformId(chat.id, inbound.replyTo) : undefined;
    const replyTo = quoted?.id ?? null;
    // A reply to something the agent said is addressed to it, even where the platform does not say so.
    const triggers = chat.kind === "dm" || inbound.addressedToBot || quoted?.direction === "out";
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
      triggers,
      createdAt: inbound.sentAt,
    });
    if (!message || !triggers) return; // Duplicate, or not addressed to the agent.

    const live = this.live.get(connectionId);

    if (this.paused.has(connection.agentId)) {
      // Not handed to the agent, and not kept for later: the person hears once per chat that it is paused.
      this.store.moveInbound([message.id], "pause");
      if (this.pauseNoted.has(chat.id)) return;
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
      void this.runtimes
        .get(connection.agentId)
        ?.stop()
        .then((stopped) =>
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
    for (const reminder of this.store.dueReminders(now)) {
      try {
        this.fireReminder(reminder, now);
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
    const source = reminder.sourceMessageId ? this.store.message(reminder.sourceMessageId) : undefined;
    const agentName = this.store.agent(reminder.agentId)?.name;
    const quoted = source && renderMessage(this.store, source, agentName ? { agentName } : {});
    const runtime = this.runtimes.get(reminder.agentId);
    if (!runtime) {
      // A paused or deleted agent has no runtime: the reminder fired but goes nowhere.
      this.log(`reminder ${reminder.id} fired but agent ${reminder.agentId} has no runtime`);
      return;
    }
    runtime.enqueueText(formatReminder(reminder, now, quoted || undefined));
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
