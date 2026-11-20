import type { Platform } from "../channels/channel.ts";
import {
  type Chat,
  type Contact,
  contactName,
  type Handoff,
  type Message,
  type Reminder,
  type Store,
} from "../store/store.ts";
import { searchTerms } from "./terms.ts";

/** ISO 8601 in local time with offset, minute precision: 2026-11-11T14:02+08:00. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const quote = (s: string) => `"${s.replaceAll('"', "'").replaceAll("\n", " ")}"`;

/** The header line plus body an agent sees for one message. Same shape for delivery and for CLI output. */
export function formatMessage(
  message: Message,
  chat: Chat,
  platform: Platform,
  opts: {
    ownerId?: string | null;
    agentName?: string;
    contact?: Contact | undefined;
    /** On delivery: messages around this one that did not reach the agent (docs/spec.md 4.2). */
    unseen?: number;
    /** On delivery: the message this one replies to, quoted under the header so the reply reads in context. */
    quoted?: { readonly from: string; readonly body: string };
  } = {},
): string {
  const parts = [`msg=${message.id}`, `chat=${chat.id}`, `im=${platform}`];
  parts.push(chat.kind === "dm" ? "dm" : `group=${quote(chat.name ?? chat.platformId)}`);
  if (chat.parentId) parts.push(`in=${chat.parentId}`);
  if (message.direction === "out" && message.notice) {
    // Mingle's own line in the chat, sent as the bot: the agent did not say it.
    parts.push('from="Mingle"', "notice");
  } else if (message.direction === "out") {
    parts.push(`from=${quote(opts.agentName ?? "you")}`, "you");
  } else {
    // The name the agent or owner gave them, else the platform's. With neither, no `from`: a platform
    // ID is not a name, and `user=` is how the agent tells people apart and names them.
    const name = contactName(opts.contact) ?? (message.senderName !== message.senderId ? message.senderName : null);
    if (name) parts.push(`from=${quote(name)}`);
    if (opts.contact) parts.push(`user=${opts.contact.id}`);
    // One person across chat apps: `mingle contact info` has their other accounts and the note.
    if (opts.contact?.personId) parts.push(`person=${opts.contact.personId}`);
    if (opts.ownerId && message.senderId === opts.ownerId) parts.push("owner");
    else if (opts.contact?.isBot) parts.push("bot");
  }
  if (message.replyTo) parts.push(`reply_to=${message.replyTo}`);
  for (const a of message.attachments) parts.push(`file=${a.id}:${quote(a.name)}`);
  parts.push(`time=${localTime(message.createdAt)}`);
  if (opts.unseen) parts.push(`unseen=${opts.unseen}`);
  const quoted = opts.quoted
    ? `${quoteLines(`${opts.quoted.from}: ${clip(opts.quoted.body, REPLY_QUOTE_CHARS)}`)}\n`
    : "";
  return `[${parts.join(" ")}]\n${quoted}${message.body}`;
}

/** Characters of a replied-to message quoted on delivery; the rest is one `message read` away. */
const REPLY_QUOTE_CHARS = 200;

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join("").trimEnd()}…` : text;
}

function quoteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Characters of context kept before and after a search match: more after, where the answer to it tends to be. */
const EXCERPT_BEFORE = 80;
const EXCERPT_AFTER = 120;

/**
 * The part of `body` around the match of `query`, for search results: enough to judge whether
 * the hit matters, not the whole message. The whole query is looked for first, then each of its
 * words. The match is wrapped in <match></match>, and a cut side is marked with "…", so the agent
 * knows it is reading a window, not the full text. Short bodies come back whole.
 */
export function excerpt(body: string, query: string, before = EXCERPT_BEFORE, after = EXCERPT_AFTER): string {
  // Positions in characters, not UTF-16 units, so a window never splits one.
  const chars = [...body];
  // The match is searched in the lowercased body, but a character can fold to several UTF-16
  // units ("İ" → "i̇"): map each unit of the folded text back to its original character index,
  // so the window and the <match> markers land on the real characters.
  const offsets: number[] = [];
  for (const [index, char] of chars.entries()) {
    for (let i = 0; i < char.toLowerCase().length; i++) offsets.push(index);
  }
  const hay = body.toLowerCase();
  let start = 0;
  let size = 0;
  for (const term of [query.trim(), ...searchTerms(query)]) {
    if (!term) continue;
    const folded = term.toLowerCase();
    const at = hay.indexOf(folded);
    if (at >= 0) {
      start = offsets[at] ?? 0;
      size = (offsets[at + folded.length - 1] ?? start) - start + 1;
      break;
    }
  }
  const width = size + before + after;
  // A window of the same width wherever the match is: near either end it slides inward.
  const from = Math.max(0, Math.min(start - before, chars.length - width));
  const to = Math.min(chars.length, from + width);
  const text = (a: number, b: number) => chars.slice(a, b).join("");
  const window =
    size > 0
      ? `${text(from, start)}<match>${text(start, start + size)}</match>${text(start + size, to)}`
      : text(from, to);
  return `${from > 0 ? "…" : ""}${window}${to < chars.length ? "…" : ""}`;
}

/** A stored message as the agent sees it, with the names and owner mark its connection gives it. */
export function renderMessage(
  store: Store,
  message: Message,
  opts: { agentName?: string; unseen?: number } = {},
): string {
  const chat = store.chat(message.chatId);
  const connection = chat && store.connection(chat.connectionId);
  if (!chat || !connection) return "";
  const contact =
    message.direction === "in" && message.senderId
      ? store.contactByPlatformId(chat.connectionId, message.senderId)
      : undefined;
  return formatMessage(message, chat, connection.platform, { ownerId: connection.ownerId, contact, ...opts });
}

/** Characters of each message in a heard stretch; the rest is one `message read` away. */
const HEARD_CHARS = 1200;

/**
 * What was said in a group that hears everything, as it reaches the agent (docs/spec.md 4.2): the
 * stretch since it last spoke there, none of it addressed to it. It may answer, or say nothing.
 */
export function formatHeard(store: Store, chat: Chat, messages: readonly Message[]): string {
  const lines = messages
    .map((m) => {
      const chars = [...m.body];
      const body =
        chars.length > HEARD_CHARS
          ? `${chars.slice(0, HEARD_CHARS).join("").trimEnd()}… (rest: message read ${chat.id} --around ${m.id})`
          : m.body;
      return renderMessage(store, { ...m, body });
    })
    .filter(Boolean);
  const count = lines.length === 1 ? "1 message" : `${lines.length} messages`;
  // The pace is the group's: a thread's stretch names the group it belongs to.
  const hearId = chat.parentId ?? chat.id;
  return [
    `[mingle] Heard in ${chat.id}: ${count} said there, none addressed to you. This group lets you hear everything; speak only when you have something worth adding, or someone there clearly means you. Answer one with \`message reply <msg>\`, or the group with \`message send --to ${chat.id}\`. Saying nothing is fine, and then do not send anything to say so. If this group is mostly not for you, hear it less: \`chat hear ${hearId} --every 1h\`, or \`--mute\` to hear nothing until someone there addresses you.`,
    ...lines,
  ].join("\n\n");
}

/** A group the agent muted, once someone addresses it there: heard at the usual pace again. */
export function formatUnmuted(groupId: string): string {
  return `[mingle] Someone in ${groupId} addressed you, so the mute you set there is over: you hear everything said there again, at the usual pace. To hear it less: \`chat hear ${groupId} --every 1h\` or \`--mute\`. This note needs no answer; answer whoever addressed you as usual.`;
}

/** Characters of a source message quoted in a reminder; the rest is one `message read` away. */
const SOURCE_QUOTE_CHARS = 500;

/**
 * A reminder as it reaches the agent. One set for a message quotes it, header included, so the
 * agent can `message reply` to it (docs/spec.md 4.6).
 */
export function formatReminder(
  reminder: Reminder,
  at: number,
  source?: string,
  check?: { readonly state: "changed" | "failing" | "expired"; readonly text: string },
): string {
  const parts = [`reminder=${reminder.id}`];
  if (reminder.chatId) parts.push(`chat=${reminder.chatId}`);
  parts.push(`time=${localTime(at)}`);
  if (check) parts.push(`check=${check.state}`);
  const text = `[${parts.join(" ")}]\n${reminder.body}${check ? `\n${check.text}` : ""}`;
  if (!source) return text;
  return `${text}\n${quoteLines(clip(source, SOURCE_QUOTE_CHARS))}`;
}

/** A handoff as it reaches the agent (docs/spec.md 4.12): one header line, then the owner's text. */
export function formatHandoff(handoff: Handoff): string {
  return `[handoff=${handoff.id} from=owner via=${handoff.via} time=${localTime(handoff.createdAt)}]\n${handoff.body.trim()}`;
}
