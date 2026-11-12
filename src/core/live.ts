import type {
  ChannelConnection,
  ChatRef,
  LiveReply,
  Platform,
  ReactionState,
  SendResult,
} from "../channels/channel.ts";

/**
 * What a person sees between sending a message and getting the answer:
 * a reaction on their message, and where the platform allows it a reply
 * that shows the agent's progress and then becomes the answer.
 */

const CHINESE: readonly Platform[] = ["wechat", "wecom", "feishu", "dingtalk", "qq"];
const RENDER_EVERY_MS = 1000;
const TICK_MS = 5000;
const MAX_STEPS = 4;

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
    failed: "处理时出错了，稍后再试。",
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
    failed: "Something went wrong. Try again in a moment.",
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
    void connection.react(chat, input.platformMessageId, "processing");
    const lang: Lang = CHINESE.includes(input.platform) ? "zh" : "en";
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
    void entry.connection.react(entry.chat, entry.platformMessageId, "done");
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

  /** The message is settled some other way. Closes its live reply with a short note. */
  settle(messageId: string, outcome: "answered" | "unanswered" | "stopped" | "failed"): void {
    const entry = this.entries.get(messageId);
    if (!entry || entry.closed) return;
    this.close(entry, messageId);
    const reaction: ReactionState = outcome === "answered" ? "done" : outcome === "failed" ? "error" : "none";
    void entry.connection.react(entry.chat, entry.platformMessageId, reaction);
    const t = TEXT[entry.lang];
    const note =
      outcome === "answered"
        ? t.answeredBelow
        : outcome === "unanswered"
          ? t.unanswered
          : outcome === "stopped"
            ? t.stopped
            : t.failed;
    void entry.live.then((live) => live?.finish(`*${note}*`)).catch(() => {});
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
    const time = elapsed < 60 ? t.seconds(elapsed) : t.minutes(Math.floor(elapsed / 60), elapsed % 60);
    const lines = [`**${entry.working ? t.working : t.thinking}** · ${time}`];
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
