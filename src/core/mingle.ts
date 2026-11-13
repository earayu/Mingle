import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
import type { Harness } from "../harness/harness.ts";
import type { SecretStore } from "../platform/secrets.ts";
import { type Agent, type Connection, Store } from "../store/store.ts";
import { MingleError, notFound } from "./errors.ts";
import { formatReminder } from "./format.ts";
import { createHome, writeRole } from "./home.ts";
import { slugify } from "./ids.ts";
import { LiveReplies } from "./live.ts";
import { Outbox } from "./outbox.ts";
import type { Paths } from "./paths.ts";
import { AgentRuntime } from "./runtime.ts";
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

export interface MingleOptions {
  readonly paths: Paths;
  readonly harness: Harness;
  readonly channels: Partial<Record<Platform, Channel>>;
  readonly secrets: SecretStore;
  /** Absolute path of the CLI entry script, run with this Node binary. */
  readonly cliEntry: string;
  readonly coalesceMs?: number;
  readonly reminderTickMs?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly log?: (line: string) => void;
}

/** The whole local process: store, agent runtimes, live IM connections, reminders. The HTTP API sits on top. */
export class Mingle {
  readonly store: Store;
  readonly outbox: Outbox;
  private readonly replies: LiveReplies;
  readonly adminToken = randomBytes(24).toString("base64url");
  private apiUrl = "";
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly live = new Map<string, ChannelConnection>();
  private readonly tokens = new Map<string, string>();
  private reminderTimer: NodeJS.Timeout | undefined;
  private readonly onboardings = new Map<string, OnboardingSession>();

  private readonly options: MingleOptions;

  constructor(options: MingleOptions) {
    this.options = options;
    for (const dir of [options.paths.home, options.paths.agents, options.paths.bin, options.paths.logs]) {
      mkdirSync(dir, { recursive: true });
    }
    this.store = new Store(options.paths.db);
    this.replies = new LiveReplies((line) => this.log(line));
    this.outbox = new Outbox(this.store, (id) => this.live.get(id), options.retryDelaysMs, this.replies);
  }

  get cliPath(): string {
    // Windows runs a .cmd by name; elsewhere a shell script.
    return join(this.options.paths.bin, process.platform === "win32" ? "mingle.cmd" : "mingle");
  }

  /** Start everything. `apiUrl` is where the HTTP API listens; agents' CLI calls go there. */
  async start(apiUrl: string): Promise<void> {
    this.apiUrl = apiUrl;
    this.writeCliWrapper();
    for (const agent of this.store.agents()) this.addRuntime(agent).start();
    await Promise.all(this.store.connections().map((c) => this.reconnect(c)));
    const tick = this.options.reminderTickMs ?? 10_000;
    this.reminderTimer = setInterval(() => this.fireReminders(), tick);
  }

  async stop(): Promise<void> {
    clearInterval(this.reminderTimer);
    this.replies.dispose();
    for (const id of [...this.onboardings.keys()]) this.cancelOnboarding(id);
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

  async availableHarnesses() {
    return this.options.harness.available();
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
    if (harnessChanged) this.store.setSessionId(agent.id, null);
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

  async deleteAgent(idOrSlug: string, removeHome: boolean): Promise<void> {
    const agent = this.agent(idOrSlug);
    for (const connection of this.store.connections(agent.id)) await this.removeConnection(connection.id);
    await this.runtimes.get(agent.id)?.dispose();
    this.runtimes.delete(agent.id);
    for (const [token, id] of this.tokens) if (id === agent.id) this.tokens.delete(token);
    this.store.deleteAgent(agent.id);
    if (removeHome) rmSync(this.homeDir(agent), { recursive: true, force: true });
  }

  async stopAgent(idOrSlug: string): Promise<boolean> {
    const agent = this.agent(idOrSlug);
    return (await this.runtimes.get(agent.id)?.stop()) ?? false;
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
      ...(this.options.coalesceMs !== undefined ? { coalesceMs: this.options.coalesceMs } : {}),
      onActivity: (kind, detail) => this.replies.activity(agent.id, kind, detail),
      onSettled: (ids, outcome) => {
        for (const id of ids) this.replies.settle(id, outcome);
      },
      log: (line) => this.log(line),
    });
    this.runtimes.set(agent.id, runtime);
    return runtime;
  }

  // ------------------------------------------------------------- connections

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
        for await (const event of channel.onboard(undefined, abort.signal, { agentName: agent.name, awaitCode })) {
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
    const existing = this.store.connections().find((c) => c.platform === platform && c.botId === event.bot.id);
    if (existing) {
      throw new MingleError(
        "bot_in_use",
        `this bot is already connected to ${this.store.agent(existing.agentId)?.name ?? "another agent"}`,
      );
    }
    const secretRef = `${platform}:${event.bot.id}`;
    await this.options.secrets.set(secretRef, JSON.stringify(event.credentials));
    const connection = this.store.createConnection({ agentId, platform, secretRef });
    this.store.updateConnection(connection.id, {
      botId: event.bot.id,
      botName: event.bot.name,
      ...(event.ownerId ? { ownerId: event.ownerId } : {}),
    });
    await this.connect(this.store.connection(connection.id) as Connection, event.credentials);
    if (event.ownerId) void this.greetOwner(connection.id, event.ownerId);
    return this.store.connection(connection.id) as Connection;
  }

  /** A new bot says hello to its owner, so the conversation shows up in their chat list. */
  private async greetOwner(connectionId: string, ownerId: string): Promise<void> {
    const connection = this.store.connection(connectionId);
    const live = this.live.get(connectionId);
    const agent = connection && this.store.agent(connection.agentId);
    if (!live?.messageUser || !agent || connection.state !== "connected") return;
    const chinese = ["wechat", "wecom", "feishu", "dingtalk", "qq"].includes(connection.platform);
    const text = chinese
      ? `你好，我是 ${agent.name}。直接在这里给我发消息，或者把我拉进群里 @ 我。`
      : `Hi, I'm ${agent.name}. Message me here, or add me to a group and @ me.`;
    await live.messageUser(ownerId, text).catch((error) => this.log(`greeting failed: ${(error as Error).message}`));
  }

  async removeConnection(connectionId: string): Promise<void> {
    const connection = this.store.connection(connectionId);
    if (!connection) return;
    await this.live
      .get(connectionId)
      ?.close()
      .catch(() => {});
    this.live.delete(connectionId);
    if (connection.secretRef) await this.options.secrets.delete(connection.secretRef);
    this.store.deleteConnection(connectionId);
  }

  isLive(connectionId: string): boolean {
    return this.live.has(connectionId);
  }

  liveConnection(connectionId: string): ChannelConnection | undefined {
    return this.live.get(connectionId);
  }

  private async reconnect(connection: Connection): Promise<void> {
    if (!connection.secretRef) return;
    const raw = await this.options.secrets.get(connection.secretRef);
    if (!raw) {
      this.store.updateConnection(connection.id, {
        state: "error",
        stateDetail: "credentials missing from the keychain",
      });
      return;
    }
    try {
      await this.connect(connection, JSON.parse(raw) as Credentials);
    } catch (error) {
      this.store.updateConnection(connection.id, { state: "error", stateDetail: (error as Error).message });
    }
  }

  private async connect(connection: Connection, credentials: Credentials): Promise<void> {
    const channel = this.channel(connection.platform);
    this.store.updateConnection(connection.id, { state: "reconnecting", stateDetail: null });
    // An adapter may report a state while connecting (for example, waiting for an admin); keep it.
    let reported = false;
    const live = await channel.connect(credentials, {
      onMessage: (message) => this.receive(connection.id, message),
      onState: (state) => {
        reported = true;
        this.onState(connection.id, state);
      },
      onMembership: (change) => this.onMembership(connection.id, change),
    });
    this.live.set(connection.id, live);
    this.store.updateConnection(connection.id, { botId: live.bot.id, botName: live.bot.name });
    if (!reported) this.store.updateConnection(connection.id, { state: "connected" });
  }

  private onState(connectionId: string, state: ConnectionState): void {
    const map = {
      connecting: "reconnecting",
      reconnecting: "reconnecting",
      connected: "connected",
      awaiting_approval: "awaiting_approval",
      error: "error",
    } as const;
    this.store.updateConnection(connectionId, {
      state: map[state.kind],
      stateDetail: state.kind === "error" ? state.code : null,
    });
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
    const chat = this.store.upsertChat({
      connectionId,
      platformId: inbound.chat.platformId,
      kind: inbound.chat.kind,
      name: inbound.chat.name,
    });
    let ownerId = connection.ownerId;
    if (!ownerId && chat.kind === "dm") {
      ownerId = inbound.sender.id;
      this.store.updateConnection(connectionId, { ownerId });
      this.log(
        `${connection.platform}: ${inbound.sender.name} is now the owner of ${connection.botName ?? connection.id}`,
      );
    }
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

    if (inbound.text.trim() === "/stop" && inbound.sender.id === ownerId) {
      this.store.setInboundState([message.id], "replied");
      for (const id of this.replies.openFor(connection.agentId)) this.replies.settle(id, "stopped");
      void this.runtimes
        .get(connection.agentId)
        ?.stop()
        .then((stopped) =>
          this.outbox
            .send(connection.agentId, {
              chatId: chat.id,
              text: stopped ? "Stopped." : "Nothing to stop.",
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

  // --------------------------------------------------------------- reminders

  fireReminders(now = Date.now()): void {
    for (const reminder of this.store.dueReminders(now)) {
      let next: number | null = null;
      if (reminder.rule !== "once") {
        try {
          next = nextFire(reminder.rule, now);
        } catch {
          next = null;
        }
      }
      this.store.setReminderNext(reminder.id, next);
      this.runtimes.get(reminder.agentId)?.enqueueText(formatReminder(reminder, now));
    }
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
