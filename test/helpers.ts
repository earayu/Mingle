import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ScriptedTurn, scriptedRuntime } from "@botiverse/oar/testing";
import { createApi, listen } from "../src/api/server.ts";
import type {
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  InboundMessage,
  OutboundMessage,
  Platform,
  ReactionState,
  Trust,
} from "../src/channels/channel.ts";
import type { Engage } from "../src/core/hearing.ts";
import type { InboundEvent } from "../src/core/inbound.ts";
import { Mingle } from "../src/core/mingle.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { type Harness, oarHarness } from "../src/harness/harness.ts";
import { memorySecrets, type SecretStore } from "../src/platform/secrets.ts";
import type { InboundState, Store } from "../src/store/store.ts";

export const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

/** A chat app that lives in memory. Tests push inbound messages and inspect what was sent. */
export class FakeChannel implements Channel {
  readonly platform = "telegram" as const;
  /** Sends the bot every group message, as Telegram does with privacy mode off. */
  readonly groupMessages = true as const;
  readonly onboarding = { kind: "credentials" as const, fields: [] };
  /** Most tests are about anything but access: everyone gets through unless a test asks otherwise. */
  trust: Trust = "org";
  /** The owner the platform reports on onboarding, if any (feishu and QQ do; Telegram does not). */
  onboardOwner: string | undefined;
  readonly sent: (OutboundMessage & { platformId: string })[] = [];
  readonly acks: string[] = [];
  readonly reactions: string[] = [];
  /** Live replies opened, with every update and the final content. */
  readonly lives: {
    chat: ChatRef;
    replyTo: string;
    platformId: string;
    updates: string[];
    final: string | undefined;
  }[] = [];
  /** Off by default so most tests see plain replies; the live-reply tests turn it on. */
  liveEnabled = false;
  /** Group members, as listMembers reports them; empty means the app cannot list them. */
  members: { id: string; name: string; isBot: boolean }[] = [];
  /**
   * How the bot opens a direct chat with someone who has not written: not at all, by getting the
   * chat's ID up front (Slack, Discord), or by the person's ID with the chat named on the first send (Feishu).
   */
  opensDirect: "none" | "chat" | "user" = "none";
  /** Whether the bot can write first to a user by their ID (messageUser), as Feishu and Slack can. */
  messagesUsers = false;
  /** Can open a thread under a message by replying into it, as Feishu and Discord can (docs/spec.md 4.13). */
  threads = false;
  /** Department and title the platform reports for each user, where member profiles are on. */
  profiles = new Map<string, string>();
  /** How many times a group's member list was read. */
  memberReads = 0;
  /** People the platform will not let the bot write to. */
  unreachable = new Set<string>();
  /** Live replies refuse their final content, as QQ's stream does past its window. */
  finishFails = false;
  /** How many times a bot connected, and how many of those connections were closed. */
  connects = 0;
  closes = 0;
  /** The next this many connect attempts throw, as when the network is down. */
  connectFailures = 0;
  private events: ChannelEvents | undefined;
  private seq = 1000;

  /** What binding the bot hands out; QQ issues a new secret on every scan. */
  onboardCredentials: Record<string, string> = { token: "fake" };
  /** The credentials of the latest connect attempt. */
  lastCredentials: unknown;

  async *onboard() {
    yield {
      kind: "succeeded" as const,
      credentials: this.onboardCredentials,
      bot: { id: "bot1", name: "@alex_bot" },
      ...(this.onboardOwner ? { ownerId: this.onboardOwner } : {}),
    };
  }

  async connect(credentials: unknown, events: ChannelEvents): Promise<ChannelConnection> {
    this.connects++;
    this.lastCredentials = credentials;
    if (this.connectFailures > 0) {
      this.connectFailures--;
      throw new Error("fixture network down");
    }
    this.events = events;
    const channel = this;
    return {
      bot: { id: "bot1", name: "@alex_bot" },
      capabilities: () => ({
        quoteReply: true,
        reactions: true,
        typingIndicator: true,
        fileUpload: true,
        fileDownload: false,
        listMembers: channel.members.length > 0,
        ...(channel.threads ? { threads: true as const } : {}),
        maxTextLength: 4096,
      }),
      send: async (message) => {
        const platformId = String(this.seq++);
        this.sent.push({ ...message, platformId });
        const byUser = this.opensDirect === "user" && message.chat.platformId.startsWith("user:");
        const thread =
          this.threads && message.inThread && message.replyTo && message.chat.kind === "group"
            ? {
                platformId: `${message.chat.platformId}:${message.replyTo}`,
                kind: "thread" as const,
                parent: { platformId: message.chat.platformId },
                followUp: true as const,
              }
            : undefined;
        return {
          kind: "sent",
          platformId,
          ...(byUser ? { chat: `dm-${message.chat.platformId.slice(5)}` } : {}),
          ...(thread ? { thread } : {}),
        };
      },
      // Read when used: tests set opensDirect after the bot has connected.
      get openDirect() {
        return channel.opensDirect === "none"
          ? undefined
          : async (userId: string) => {
              if (channel.unreachable.has(userId)) throw new Error("fixture: not in the bot's range");
              return channel.opensDirect === "chat" ? `dm-${userId}` : `user:${userId}`;
            };
      },
      ...(this.messagesUsers
        ? {
            messageUser: async (userId: string, text: string) => {
              const platformId = String(this.seq++);
              const chat = { platformId: `dm-${userId}`, kind: "dm" as const };
              this.sent.push({ chat, text, platformId });
              return { chat: chat.platformId, platformId };
            },
          }
        : {}),
      react: async (_chat: ChatRef, id: string, state: ReactionState) => {
        this.reactions.push(`${id}:${state}`);
        if (state === "processing") this.acks.push(id);
      },
      ...(this.liveEnabled
        ? {
            startLive: async (chat: ChatRef, options: { replyTo: string; initial: string }) => {
              const platformId = String(this.seq++);
              const record = {
                chat,
                replyTo: options.replyTo,
                platformId,
                updates: [options.initial],
                final: undefined as string | undefined,
              };
              this.lives.push(record);
              return {
                update: async (markdown: string) => {
                  record.updates.push(markdown);
                },
                finish: async (markdown: string) => {
                  if (this.finishFails) return { kind: "failed" as const, code: "unknown" as const, retryable: false };
                  record.final = markdown;
                  return { kind: "sent" as const, platformId };
                },
              };
            },
          }
        : {}),
      setTyping: async () => {},
      download: async () => {},
      profile: async (userId: string) => channel.profiles.get(userId),
      listMembers: async () => {
        this.memberReads++;
        return this.members;
      },
      close: async () => {
        this.closes++;
      },
    } as ChannelConnection;
  }

  /** Report a state of the live connection, as the platform adapter would. */
  report(state: Parameters<ChannelEvents["onState"]>[0]): void {
    this.events?.onState(state);
  }

  /** The bot was added to a group, as the platform reports it. */
  joined(chat: ChatRef): void {
    this.events?.onMembership({ chat, joined: true });
  }

  /** Deliver a message as if it arrived from the platform. */
  receive(partial: Partial<InboundMessage> & { text: string }): InboundMessage {
    const message: InboundMessage = {
      platformId: String(this.seq++),
      chat: { platformId: "-100", kind: "group", name: "Weekend hikes" },
      sender: { id: "u1", name: "Zhang San", isBot: false },
      attachments: [],
      addressedToBot: true,
      sentAt: Date.now(),
      ...partial,
    };
    this.events?.onMessage(message);
    return message;
  }
}

/** cmd.exe joins argv back into one line, so a multiword argument must arrive quoted. */
function cmdQuote(arg: string): string {
  return /[\s&|<>^"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

function run(file: string, args: string[], env: Record<string, string>, stdin: string, shell: boolean) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(file, args, { env: { ...process.env, ...env }, shell }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

/**
 * Run the real `mingle` CLI the way an agent would, with the session's environment. Windows runs a
 * .cmd only through a shell, as a harness does; Node then concatenates argv without quoting, so
 * multiword arguments are quoted for cmd to keep each one whole.
 */
export function runCli(
  env: Record<string, string>,
  args: string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  const windows = process.platform === "win32";
  return run(env.MINGLE_CLI as string, windows ? args.map(cmdQuote) : args, env, stdin, windows);
}

/** Run the CLI entry with `node` and no shell: argv reaches it word for word, on every platform. */
export function runCliNode(
  env: Record<string, string>,
  args: string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return run(process.execPath, [CLI_ENTRY, ...args], env, stdin, false);
}

export async function until<T>(check: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface Rig {
  mingle: Mingle;
  /** MINGLE_HOME of this Mingle. */
  home: string;
  url: string;
  /** Call the admin API as the console does. */
  admin(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  channel: FakeChannel;
  agentId: string;
  turns: { readonly input: string; readonly steered: string[] }[];
  close(): Promise<void>;
}

/** A full Mingle (store, runtime, HTTP API, CLI) with a scripted harness and a fake chat app. */
export async function rig(
  turn: (t: ScriptedTurn) => Promise<void>,
  options: {
    harness?: string;
    model?: string | null;
    real?: boolean;
    /** Fully replaces the harness adapter (e.g. a wrapper around a runtime). */
    harnessAdapter?: Harness;
    coalesceMs?: number;
    /** Scripted turns that do nothing are "empty"; by default they are checked at once, like a model's silence. */
    emptyTurnWaitMs?: number;
    /** How long a turn may go without any harness event before Mingle stops it. */
    stallMs?: number;
    live?: boolean;
    channels?: Partial<Record<Platform, Channel>>;
    /** Change what the harness reports, e.g. to make a failed turn look like a sign-in problem. */
    wrap?: (harness: Harness) => Harness;
    secrets?: SecretStore;
    /** Every line Mingle logs. */
    log?: (line: string) => void;
    /** `MINGLE_COLD_START`: which agents open a fresh session on a cold start. */
    coldStart?: string;
    /** The bot's owner as the platform reports it on connecting; without it, the bot waits to be claimed. */
    owner?: string;
    /** The fake chat app lets the bot write first to a user by their ID (messageUser). */
    messagesUsers?: boolean;
    /** Who the fake chat app says can reach its bots; "org" unless a test is about access. */
    trust?: Trust;
    remoteTransport?: import("../src/core/remotes.ts").RemoteTransport;
    /** Pacing of a group that hears everything (`MingleOptions.hearing`). */
    hearing?: { quietMs: number; maxWaitMs: number; gapMs: number };
    /** Engagement in a group that hears everything (`MingleOptions.engage`). */
    engage?: Partial<Engage>;
    /** The agent's role; a hiking helper unless a test needs another. */
    role?: string;
    proxy?: import("../src/platform/net.ts").NetworkProxyController;
    shellProxyEnv?: Readonly<Record<string, string | undefined>>;
    detectSystemProxy?: () => Promise<import("../src/platform/proxy.ts").SystemProxyInfo>;
    testProxy?: (url: string) => Promise<import("../src/platform/net.ts").ProxyTestResult>;
  } = {},
): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "mingle-test-"));
  const channel = new FakeChannel();
  channel.liveEnabled = Boolean(options.live);
  channel.onboardOwner = options.owner;
  channel.messagesUsers = Boolean(options.messagesUsers);
  channel.trust = options.trust ?? "org";
  const turns: Rig["turns"] = [];
  const runtime = scriptedRuntime({
    id: "scripted",
    turn: async (t) => {
      // Read steered inputs live: a test may look before the script returns.
      turns.push({
        input: t.input,
        get steered() {
          return [...t.steered];
        },
      });
      await turn(t);
    },
  });
  const innerHarness = options.harnessAdapter ?? (options.real ? oarHarness() : oarHarness({ require: () => runtime }));
  // The agent's harness id is not in OAR's offered list; list it so the admin API can check it.
  const agentHarness = options.harness ?? "scripted";
  const harness: Harness = {
    ...innerHarness,
    available: async () => {
      const list = await innerHarness.available();
      if (options.real || options.harnessAdapter || list.some((h) => h.id === agentHarness)) return list;
      return [...list, { id: agentHarness, name: agentHarness }];
    },
  };
  const mingle = new Mingle({
    ...(options.remoteTransport ? { remoteTransport: options.remoteTransport } : {}),
    paths: resolvePaths(home),
    harness: options.wrap ? options.wrap(harness) : harness,
    channels: { telegram: channel, ...options.channels },
    secrets: options.secrets ?? memorySecrets(),
    cliEntry: CLI_ENTRY,
    coalesceMs: options.coalesceMs ?? 150,
    emptyTurnWaitMs: options.emptyTurnWaitMs ?? 0,
    // A real harness needs the time to begin its own turn after background work.
    ...(options.real ? {} : { lineSettleMs: 300 }),
    ...(options.stallMs !== undefined ? { stallMs: options.stallMs } : {}),
    ...(options.coldStart ? { coldStart: options.coldStart } : {}),
    reminderTickMs: 60_000,
    retryDelaysMs: [10],
    reconnectDelaysMs: [30],
    ...(options.hearing ? { hearing: options.hearing } : {}),
    ...(options.engage ? { engage: options.engage } : {}),
    ...(options.proxy ? { proxy: options.proxy } : {}),
    ...(options.shellProxyEnv ? { shellProxyEnv: options.shellProxyEnv } : {}),
    detectSystemProxy:
      options.detectSystemProxy ??
      (async () => ({
        url: null,
        httpUrl: null,
        httpsUrl: null,
        socksUrl: null,
        bypass: [],
        pacOnly: false,
        source: "none" as const,
      })),
    ...(options.testProxy ? { testProxy: options.testProxy } : {}),
    // MINGLE_E2E_LOG=1 prints what Mingle logs, to see why a real harness did not answer.
    ...(process.env.MINGLE_E2E_LOG ? { log: (line: string) => console.log(`[mingle] ${line}`) } : {}),
    ...(options.log ? { log: options.log } : {}),
  });
  const server = await listen(createApi(mingle), 0);
  await mingle.start(server.url);
  const agent = mingle.createAgent({
    name: "Alex",
    role: options.role ?? "You help a group of friends plan weekend hikes. Keep replies to one or two sentences.",
    harness: options.harness ?? "scripted",
    model: options.model ?? null,
  });
  await mingle.addConnection(agent.id, "telegram", { token: "fake" });
  return {
    mingle,
    home,
    url: server.url,
    channel,
    agentId: agent.id,
    async admin(method, path, body) {
      const response = await fetch(`${server.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${mingle.adminToken}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    turns,
    async close() {
      await mingle.stop();
      await server.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Message IDs in a delivered input, in order. */
export const messageIds = (text: string) => [...text.matchAll(/\bmsg=(m\w+)/g)].map((m) => m[1] as string);

/** Like `until`, for checks that need to await (an HTTP call, say). */
export async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Walk a received inbound message to `state` the way Mingle would, through its allowed transitions. */
export function driveInbound(store: Store, id: string, state: InboundState): void {
  const path: Record<InboundState, InboundEvent[]> = {
    received: [],
    delivered: ["deliver"],
    waiting: ["deliver", "hold"],
    failed: ["deliver", "fail"],
    unanswered: ["deliver", "give_up"],
    replied: ["deliver", "reply"],
    ignored: ["deliver", "fail", "ignore"],
    // Only ever inserted so: no event leads to it.
    held: [],
  };
  for (const event of path[state]) {
    if (store.moveInbound([id], event).length !== 1) throw new Error(`${id} could not ${event}`);
  }
}
