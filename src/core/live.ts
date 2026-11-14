import type {
  ChannelConnection,
  ChatRef,
  LiveReply,
  Platform,
  ReactionState,
  SendResult,
} from "../channels/channel.ts";
import type { Failure } from "../harness/harness.ts";

/**
 * What a person sees between sending a message and getting the answer:
 * a reaction on their message, and where the platform allows it a reply
 * that shows the agent's progress and then becomes the answer.
 */

const CHINESE: readonly Platform[] = ["wechat", "wecom", "feishu", "dingtalk", "qq"];
const RENDER_EVERY_MS = 1000;
const TICK_MS = 5000;
const MAX_STEPS = 4;
/** Below this many seconds the progress line shows no elapsed time. */
const SHOW_TIME_AFTER_S = 3;

type Lang = "zh" | "en";

const TEXT = {
  zh: {
    thinking: "正在思考",
    working: "正在处理",
    seconds: (n: number) => `${n} 秒`,
    minutes: (m: number, s: number) => `${m} 分 ${s} 秒`,
    answeredBelow: "已回复，见下方消息。",
    unanswered: "这条消息没有得到回复。",
    stopped: "已叫停。",
    paused: "已暂停，这条消息不会再回复。",
    pausedNote: (name: string) => `${name} 已暂停，暂时不回复消息。`,
    failed: "处理时出错了，请稍后再发一次。",
    nothingToStop: "现在没有在处理的事。",
    failures: {
      auth: (h: string) => `${h} 没有登录，暂时回复不了。请在运行 Mingle 的电脑上登录 ${h}，然后再发一次。`,
      quota: (h: string, until?: string) =>
        `${h} 的用量额度用完了，暂时回复不了${until ? `，预计 ${until} 恢复` : ""}。`,
      billing: (h: string) => `${h} 的账户需要充值或付费，暂时回复不了。`,
      model: () => "当前选的模型用不了。请在 Mingle 里换一个模型，然后再发一次。",
      busy: (h: string) => `${h} 那边暂时繁忙，请过一会儿再发一次。`,
      tooLarge: () => "这次的内容太长，处理不了。请精简后再发。",
      notInstalled: (h: string) => `这台电脑上找不到 ${h}，暂时回复不了。`,
    },
    waiting: {
      quota: (h: string, until?: string) =>
        `${h} 的用量额度用完了${until ? `，预计 ${until} 恢复` : ""}。这条消息会先等着，恢复后自动回复，不用再发。`,
      busy: (h: string, minutes: number) => `${h} 那边暂时繁忙，${minutes} 分钟后自动重试，不用再发。`,
    },
    steps: {
      command: "运行命令",
      read: "查看文件",
      edit: "修改文件",
      search: "搜索",
      web: "查资料",
      delegate: "分派子任务",
      plan: "整理计划",
      other: "使用工具",
    },
  },
  en: {
    thinking: "Thinking",
    working: "Working",
    seconds: (n: number) => `${n}s`,
    minutes: (m: number, s: number) => `${m}m ${s}s`,
    answeredBelow: "Answered below.",
    unanswered: "This message did not get a reply.",
    stopped: "Stopped.",
    paused: "Paused. This message won't get a reply.",
    pausedNote: (name: string) => `${name} is paused and not replying for now.`,
    failed: "Something went wrong. Send it again in a moment.",
    nothingToStop: "Nothing to stop.",
    failures: {
      auth: (h: string) =>
        `${h} is not signed in, so I can't reply. Sign in to ${h} on the computer running Mingle, then send this again.`,
      quota: (h: string, until?: string) =>
        `${h} has used up its usage limit${until ? ` until ${until}` : ""}, so I can't reply right now.`,
      billing: (h: string) => `${h} needs a payment or more credits before I can reply.`,
      model: () => "The selected model can't be used. Pick another model in Mingle, then send this again.",
      busy: (h: string) => `${h} is busy right now. Send this again in a little while.`,
      tooLarge: () => "This is too long to handle. Shorten it and send again.",
      notInstalled: (h: string) => `${h} is not installed on this computer, so I can't reply.`,
    },
    waiting: {
      quota: (h: string, until?: string) =>
        `${h} has used up its usage limit${until ? ` until ${until}` : ""}. This message will wait and get a reply once it resets; no need to send it again.`,
      busy: (h: string, minutes: number) =>
        `${h} is busy right now. I'll try again in ${minutes} min; no need to send it again.`,
    },
    steps: {
      command: "Running a command",
      read: "Reading files",
      edit: "Editing files",
      search: "Searching",
      web: "Looking things up",
      delegate: "Handing off a subtask",
      plan: "Planning",
      other: "Using a tool",
    },
  },
} as const;

type StepKind = keyof (typeof TEXT)["en"]["steps"];

/** Why a reply failed, as settle() receives it. */
export interface FailureNote {
  readonly failure: Failure;
  /** Display name of the agent's harness ("Claude Code"). */
  readonly harness: string;
  readonly resetsAt?: number;
  /** For a message left waiting: when Mingle tries it again. */
  readonly retryAt?: number;
}

export function langFor(platform: Platform): Lang {
  return CHINESE.includes(platform) ? "zh" : "en";
}

/** "Stopped." / "Nothing to stop." in the chat's language. */
export function stopNote(platform: Platform, stopped: boolean): string {
  const t = TEXT[langFor(platform)];
  return stopped ? t.stopped : t.nothingToStop;
}

/** What Mingle tells a chat that writes to a paused agent, in the chat's language. */
export function pausedNote(platform: Platform, name: string): string {
  return TEXT[langFor(platform)].pausedNote(name);
}

/** What to tell the person when the agent could not answer: what happened, and what helps. */
export function failureText(lang: Lang, why: FailureNote | undefined, now = Date.now()): string {
  const t = TEXT[lang];
  if (!why) return t.failed;
  const h = why.harness;
  const f = t.failures;
  switch (why.failure) {
    case "auth":
      return f.auth(h);
    case "quota":
      return f.quota(h, why.resetsAt && why.resetsAt > now ? resetTime(lang, why.resetsAt, now) : undefined);
    case "billing":
      return f.billing(h);
    case "model_unavailable":
      return f.model();
    case "rate_limited":
    case "overloaded":
    case "provider":
      return f.busy(h);
    case "input_too_large":
      return f.tooLarge();
    case "not_installed":
      return f.notInstalled(h);
    default:
      return t.failed;
  }
}

/** What to tell the person whose message waits for a passing failure: what happened, and that it will be answered. */
export function waitingText(lang: Lang, why: FailureNote, now = Date.now()): string {
  const w = TEXT[lang].waiting;
  if (why.failure === "quota") {
    return w.quota(why.harness, why.resetsAt && why.resetsAt > now ? resetTime(lang, why.resetsAt, now) : undefined);
  }
  return w.busy(why.harness, Math.max(1, Math.round(((why.retryAt ?? now) - now) / 60_000)));
}

function resetTime(lang: Lang, at: number, now: number): string {
  const locale = lang === "zh" ? "zh-CN" : "en";
  const time = new Date(at);
  const sameDay = new Date(now).toDateString() === time.toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(time);
}

/** A note sent as its own message at most this often per chat, so a burst of failures is one note. */
const NOTE_EVERY_MS = 60_000;

/** A harness tool name in plain words. Names differ per harness (Bash, shell, exec_command…). */
export function stepKind(tool: string): StepKind {
  const name = tool.toLowerCase();
  if (/todo|plan/.test(name)) return "plan";
  if (/web|fetch|browse|http|url/.test(name)) return "web";
  if (/bash|shell|exec|command|terminal|run/.test(name)) return "command";
  if (/grep|glob|search|find/.test(name)) return "search";
  if (/edit|write|patch|create|replace|multiedit/.test(name)) return "edit";
  if (/read|view|cat|list|ls/.test(name)) return "read";
  if (/task|agent|delegate|spawn/.test(name)) return "delegate";
  return "other";
}

interface Entry {
  readonly agentId: string;
  readonly chat: ChatRef;
  readonly platformMessageId: string;
  readonly connection: ChannelConnection;
  readonly lang: Lang;
  readonly startedAt: number;
  live: Promise<LiveReply | undefined>;
  working: boolean;
  steps: { kind: StepKind; count: number }[];
  lastRender: number;
  pending: NodeJS.Timeout | undefined;
  tick: NodeJS.Timeout | undefined;
  closed: boolean;
}

export class LiveReplies {
  private readonly entries = new Map<string, Entry>();
  private readonly notedAt = new Map<string, number>();
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(log: (line: string) => void = () => {}, now: () => number = Date.now) {
    this.log = log;
    this.now = now;
  }

  /** A message the agent will handle arrived: react, and open a live reply where possible. */
  open(input: {
    messageId: string;
    agentId: string;
    platform: Platform;
    chat: ChatRef;
    platformMessageId: string;
    senderId: string;
    connection: ChannelConnection;
  }): void {
    const { connection, chat } = input;
    void connection.react(chat, input.platformMessageId, "processing").catch(() => {});
    const lang = langFor(input.platform);
    const entry: Entry = {
      agentId: input.agentId,
      chat,
      platformMessageId: input.platformMessageId,
      connection,
      lang,
      startedAt: this.now(),
      live: Promise.resolve(undefined),
      working: false,
      steps: [],
      lastRender: 0,
      pending: undefined,
      tick: undefined,
      closed: false,
    };
    if (connection.startLive) {
      entry.live = connection
        .startLive(chat, {
          replyTo: input.platformMessageId,
          ...(chat.kind !== "dm" ? { mention: input.senderId } : {}),
          initial: this.render(entry),
        })
        .catch((error) => {
          this.log(`live reply could not start: ${(error as Error).message}`);
          return undefined;
        });
      // Keep the elapsed time moving even while nothing else happens.
      entry.tick = setInterval(() => this.schedule(entry), TICK_MS);
      entry.tick.unref?.();
    }
    this.entries.set(input.messageId, entry);
  }

  /** Progress from the agent's harness. Applies to every open reply of that agent. */
  activity(agentId: string, kind: "thinking" | "tool", tool?: string): void {
    for (const entry of this.entries.values()) {
      if (entry.agentId !== agentId || entry.closed) continue;
      if (kind === "tool") {
        entry.working = true;
        const step = stepKind(tool ?? "");
        const last = entry.steps.at(-1);
        if (last?.kind === step) last.count++;
        else entry.steps.push({ kind: step, count: 1 });
      }
      this.schedule(entry);
    }
  }

  /**
   * The agent answered this message. If a live reply is open, the answer goes into it
   * and its result is returned; otherwise undefined, and the caller sends normally.
   */
  async answer(messageId: string, markdown: string): Promise<SendResult | undefined> {
    const entry = this.entries.get(messageId);
    if (!entry || entry.closed) return undefined;
    this.close(entry, messageId);
    void entry.connection.react(entry.chat, entry.platformMessageId, "done").catch(() => {});
    const live = await entry.live;
    if (!live) return undefined;
    try {
      const result = await live.finish(markdown);
      return result.kind === "sent" ? result : undefined;
    } catch (error) {
      this.log(`live reply could not finish: ${(error as Error).message}`);
      return undefined;
    }
  }

  /**
   * The message is settled some other way. Closes its live reply with a short note.
   * A failure, or a wait for one to pass, is always told: where no live reply can carry it, as a
   * message of its own.
   */
  settle(
    messageId: string,
    outcome: "answered" | "unanswered" | "stopped" | "paused" | "failed" | "waiting",
    why?: FailureNote,
  ): void {
    const entry = this.entries.get(messageId);
    if (!entry || entry.closed) return;
    this.close(entry, messageId);
    const reaction: ReactionState = outcome === "answered" ? "done" : outcome === "failed" ? "error" : "none";
    void entry.connection.react(entry.chat, entry.platformMessageId, reaction).catch(() => {});
    const t = TEXT[entry.lang];
    const note =
      outcome === "answered"
        ? t.answeredBelow
        : outcome === "unanswered"
          ? t.unanswered
          : outcome === "stopped"
            ? t.stopped
            : outcome === "paused"
              ? t.paused
              : outcome === "waiting" && why
                ? waitingText(entry.lang, why, this.now())
                : failureText(entry.lang, why, this.now());
    void entry.live
      .then(async (live) => {
        const result = live ? await live.finish(`*${note}*`).catch(() => undefined) : undefined;
        // No live reply, or it could not be finished (QQ's stream window, a refused frame):
        // a failure still reaches the person, as its own message.
        // A message left waiting is told the same way: the person should not send it again.
        if (result?.kind !== "sent" && (outcome === "failed" || outcome === "waiting"))
          await this.sendNote(entry, note);
      })
      .catch((error) => this.log(`could not tell about a failed reply: ${(error as Error).message}`));
  }

  private async sendNote(entry: Entry, note: string): Promise<void> {
    const key = `${entry.agentId}\u0000${entry.chat.platformId}`;
    const last = this.notedAt.get(key);
    if (last !== undefined && this.now() - last < NOTE_EVERY_MS) return;
    this.notedAt.set(key, this.now());
    const result = await entry.connection.send({ chat: entry.chat, text: note, replyTo: entry.platformMessageId });
    if (result.kind !== "sent") this.log(`failure note was not sent (${result.kind})`);
  }

  /** Open replies of an agent, e.g. to settle them all when its turn fails. */
  openFor(agentId: string): string[] {
    return [...this.entries].filter(([, e]) => e.agentId === agentId && !e.closed).map(([id]) => id);
  }

  dispose(): void {
    for (const [id, entry] of this.entries) this.close(entry, id);
  }

  private close(entry: Entry, messageId: string): void {
    entry.closed = true;
    clearTimeout(entry.pending);
    clearInterval(entry.tick);
    this.entries.delete(messageId);
  }

  private schedule(entry: Entry): void {
    if (entry.closed || entry.pending) return;
    const wait = Math.max(0, entry.lastRender + RENDER_EVERY_MS - this.now());
    entry.pending = setTimeout(() => {
      entry.pending = undefined;
      if (entry.closed) return;
      entry.lastRender = this.now();
      const content = this.render(entry);
      void entry.live.then((live) => live?.update(content)).catch(() => {});
    }, wait);
  }

  /** The progress shown while the agent works. */
  render(entry: Pick<Entry, "lang" | "startedAt" | "working" | "steps">): string {
    const t = TEXT[entry.lang];
    const elapsed = Math.max(0, Math.round((this.now() - entry.startedAt) / 1000));
    const label = entry.working ? t.working : t.thinking;
    // The first frame goes out at once; "· 0 s" there says nothing, and on a platform that
    // keeps showing it, it reads as stuck. The time appears once there is some to show.
    const lines = [
      elapsed < SHOW_TIME_AFTER_S
        ? `**${label}…**`
        : `**${label}** · ${elapsed < 60 ? t.seconds(elapsed) : t.minutes(Math.floor(elapsed / 60), elapsed % 60)}`,
    ];
    const recent = entry.steps.slice(-MAX_STEPS);
    if (recent.length > 0) {
      lines.push("");
      // A Markdown list: Feishu renders real bullets, Telegram shows "- ". The current step ends in "…".
      recent.forEach((step, i) => {
        const current = i === recent.length - 1;
        const label = `${t.steps[step.kind]}${step.count > 1 ? ` ×${step.count}` : ""}`;
        lines.push(`- ${label}${current ? "…" : ""}`);
      });
    }
    return lines.join("\n");
  }
}
