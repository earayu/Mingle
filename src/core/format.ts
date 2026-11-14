import type { Platform } from "../channels/channel.ts";
import { type Chat, type Contact, contactName, type Message, type Reminder, type Store } from "../store/store.ts";
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
  } = {},
): string {
  const parts = [`msg=${message.id}`, `chat=${chat.id}`, `im=${platform}`];
  parts.push(chat.kind === "dm" ? "dm" : `group=${quote(chat.name ?? chat.platformId)}`);
  if (chat.parentId) parts.push(`in=${chat.parentId}`);
  if (message.direction === "out") {
    parts.push(`from=${quote(opts.agentName ?? "you")}`, "you");
  } else {
    // The name the agent or owner gave them, else the platform's. With neither, no `from`: a platform
    // ID is not a name, and `user=` is how the agent tells people apart and names them.
    const name = contactName(opts.contact) ?? (message.senderName !== message.senderId ? message.senderName : null);
    if (name) parts.push(`from=${quote(name)}`);
    if (opts.contact) parts.push(`user=${opts.contact.id}`);
    if (opts.ownerId && message.senderId === opts.ownerId) parts.push("owner");
  }
  if (message.replyTo) parts.push(`reply_to=${message.replyTo}`);
  for (const a of message.attachments) parts.push(`file=${a.id}:${quote(a.name)}`);
  parts.push(`time=${localTime(message.createdAt)}`);
  if (opts.unseen) parts.push(`unseen=${opts.unseen}`);
  return `[${parts.join(" ")}]\n${message.body}`;
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

/** Characters of a source message quoted in a reminder; the rest is one `message read` away. */
const SOURCE_QUOTE_CHARS = 500;

/**
 * A reminder as it reaches the agent. One set for a message quotes it, header included, so the
 * agent can `message reply` to it (docs/spec.md 4.6).
 */
export function formatReminder(reminder: Reminder, at: number, source?: string): string {
  const parts = [`reminder=${reminder.id}`];
  if (reminder.chatId) parts.push(`chat=${reminder.chatId}`);
  parts.push(`time=${localTime(at)}`);
  const text = `[${parts.join(" ")}]\n${reminder.body}`;
  if (!source) return text;
  const chars = [...source];
  const cut = chars.length > SOURCE_QUOTE_CHARS ? `${chars.slice(0, SOURCE_QUOTE_CHARS).join("").trimEnd()}…` : source;
  return `${text}\n${cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n")}`;
}
