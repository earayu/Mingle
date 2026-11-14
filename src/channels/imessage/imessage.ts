import { execFile } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BotIdentity,
  Capabilities,
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  Credentials,
  InboundAttachment,
  InboundMessage,
  OnboardingContext,
  OnboardingEvent,
  OutboundMessage,
  Sender,
  SendResult,
} from "../channel.ts";

/**
 * iMessage through the Messages app on this Mac (docs/spec.md 6.6). A personal-account channel:
 * the Mac's Messages must be signed in to an Apple ID that belongs to the agent, not the owner's own.
 *
 * Receiving: poll the local Messages database (`~/Library/Messages/chat.db`, read-only; needs Full
 * Disk Access). Sending: AppleScript to Messages (macOS asks once for permission to control it).
 * Nothing leaves the Mac except through Messages itself.
 */

/** Runs an AppleScript with arguments and resolves with its output. */
export type ScriptRunner = (script: string, args: readonly string[], timeoutMs: number) => Promise<string>;

export class ScriptError extends Error {
  readonly timedOut: boolean;
  constructor(message: string, timedOut = false) {
    super(message);
    this.timedOut = timedOut;
  }
}

export interface IMessageOptions {
  /** Path of the Messages database. Default `~/Library/Messages/chat.db`. */
  readonly dbPath?: string;
  readonly runScript?: ScriptRunner;
  /** How often to look for new messages. */
  readonly pollMs?: number;
  /** How long to look for a sent message in the database before giving up on its id. */
  readonly sentLookupMs?: number;
  readonly now?: () => number;
}

const CAPABILITIES: Capabilities = {
  // AppleScript can neither reply inline nor tapback; Messages shows no typing indicator for scripts.
  quoteReply: false,
  reactions: false,
  typingIndicator: false,
  fileUpload: true,
  fileDownload: true,
  listMembers: true,
  maxTextLength: 8000,
};

/** Seconds between 1970-01-01 and 2001-01-01, the epoch Messages counts from. */
const APPLE_EPOCH_MS = 978_307_200_000;
/** On connect, messages this recent are delivered again; the core drops the ones it already has. */
const BACKFILL_MS = 10 * 60_000;

/** Group chats have style 43 in chat.db; direct chats 45. */
const STYLE_GROUP = 43;

export function imessageChannel(options: IMessageOptions = {}): Channel {
  const dbPath = options.dbPath ?? join(homedir(), "Library", "Messages", "chat.db");
  const runScript = options.runScript ?? osascript;
  const pollMs = options.pollMs ?? 1000;
  const sentLookupMs = options.sentLookupMs ?? 5000;
  const now = options.now ?? Date.now;

  return {
    platform: "imessage",
    onboarding: {
      kind: "credentials",
      fields: [{ key: "owner", labelKey: "imessage.owner", secret: false }],
    },

    async *onboard(input: Credentials | undefined, _signal, context?: OnboardingContext) {
      const owner = normalizeHandle(input?.owner ?? "");
      if (!owner) {
        yield { kind: "failed", code: "invalid_credentials" } satisfies OnboardingEvent;
        return;
      }
      let account: string | undefined;
      try {
        const db = openDb(dbPath);
        try {
          account = accountHandle(db);
        } finally {
          db.close();
        }
      } catch (error) {
        yield { kind: "failed", code: isPermissionError(error) ? "permission_missing" : "unknown" };
        return;
      }
      // Asks macOS for permission to control Messages now, while the person is at the console.
      let description: string;
      try {
        description = (await runScript(ACCOUNT_SCRIPT, [], 60_000)).trim();
      } catch (error) {
        yield { kind: "failed", code: isAutomationDenied(error) ? "permission_missing" : "unknown" };
        return;
      }
      if (!description) {
        // Messages is not signed in to iMessage.
        yield { kind: "failed", code: "invalid_credentials" };
        return;
      }
      if (sameHandle(owner, account) || sameHandle(owner, description)) {
        // The owner's own Apple ID: the agent would speak as the owner (docs/spec.md 1.4).
        yield { kind: "failed", code: "owner_account" };
        return;
      }
      const handle = account ?? normalizeHandle(description) ?? "imessage";
      const name = context?.agentName?.trim() || handle;
      yield {
        kind: "succeeded",
        credentials: { owner, handle, name, since: String(now()) },
        bot: { id: handle, name: handle },
        ownerId: owner,
      };
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const handle = credentials.handle ?? "";
      const agentName = credentials.name ?? "";
      const since = Number(credentials.since ?? 0);
      const bot: BotIdentity = { id: handle, name: handle };
      let db: DatabaseSync;
      try {
        db = openDb(dbPath);
      } catch (error) {
        // Without Full Disk Access only the person can help; anything else the core retries.
        if (isPermissionError(error)) events.onState({ kind: "error", code: "permission_missing" });
        throw error;
      }
      let lastRowId = startRow(db, Math.max(since, now() - BACKFILL_MS));
      // An open handle keeps reading a file that was moved or replaced; watch the path itself.
      let inode = statSync(dbPath).ino;
      let closed = false;
      let failures = 0;
      let timer: NodeJS.Timeout | undefined;

      const read = () => {
        const rows = newMessages(db, lastRowId);
        for (const row of rows) {
          lastRowId = Math.max(lastRowId, row.rowid);
          const inbound = toInbound(row, attachmentsOf(db, row.rowid), { handle, name: agentName });
          if (inbound) events.onMessage(inbound);
        }
      };

      const tick = () => {
        if (closed) return;
        try {
          if (failures > 0) {
            db = openDb(dbPath);
            inode = statSync(dbPath).ino;
          } else if (statSync(dbPath).ino !== inode) {
            throw new Error("the Messages database was replaced");
          }
          read();
          if (failures > 0) events.onState({ kind: "connected" });
          failures = 0;
        } catch (error) {
          try {
            db.close();
          } catch {}
          if (isPermissionError(error)) {
            // Full Disk Access was taken away: only the person can give it back.
            events.onState({ kind: "error", code: "permission_missing" });
            closed = true;
            return;
          }
          failures++;
          events.onState({ kind: "reconnecting", attempt: failures });
        }
        timer = setTimeout(tick, failures ? Math.min(30_000, pollMs * 2 ** failures) : pollMs);
      };
      timer = setTimeout(tick, 0);

      /** The newest message this account sent in a chat after `after`, to learn a sent message's id. */
      const findSent = async (chatGuid: string, after: number): Promise<string | undefined> => {
        const deadline = now() + sentLookupMs;
        while (!closed) {
          try {
            const row = db
              .prepare(
                `SELECT m.guid AS guid FROM message m
                 JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                 JOIN chat c ON c.ROWID = cmj.chat_id
                 WHERE c.guid = ? AND m.is_from_me = 1 AND m.ROWID > ?
                 ORDER BY m.ROWID DESC LIMIT 1`,
              )
              .get(chatGuid, after) as { guid: string } | undefined;
            if (row) return row.guid;
          } catch {}
          if (now() >= deadline) return undefined;
          await sleep(Math.min(250, pollMs));
        }
        return undefined;
      };

      const maxRow = (): number => {
        try {
          return (db.prepare("SELECT IFNULL(MAX(ROWID), 0) AS n FROM message").get() as { n: number }).n;
        } catch {
          return lastRowId;
        }
      };

      return {
        bot,
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          const chatGuid = message.chat.platformId;
          const before = maxRow();
          const degraded: ("quote_dropped" | "markdown_flattened")[] = [];
          if (message.replyTo) degraded.push("quote_dropped");
          const text = plain(message.text);
          if (text !== message.text) degraded.push("markdown_flattened");
          try {
            if (text) await runScript(SEND_TEXT_SCRIPT, [text, chatGuid], 30_000);
            for (const file of message.files ?? []) {
              await runScript(SEND_FILE_SCRIPT, [file.path, chatGuid], 120_000);
            }
          } catch (error) {
            return sendFailure(error);
          }
          const id = await findSent(chatGuid, before);
          // Messages accepted it; the database may lag. A local id keeps the record without a guid.
          return {
            kind: "sent",
            platformId: id ?? `local:${now()}`,
            ...(degraded.length ? { degraded } : {}),
          };
        },

        async react() {},
        async setTyping() {},

        async download(attachment: InboundAttachment, toPath: string) {
          await copyFile(expandHome(attachment.id), toPath);
        },

        async messageUser(userId: string, text: string) {
          await runScript(SEND_TO_HANDLE_SCRIPT, [plain(text), userId], 30_000);
        },

        async listMembers(chat: ChatRef): Promise<readonly Sender[]> {
          const rows = db
            .prepare(
              `SELECT h.id AS id FROM chat c
               JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
               JOIN handle h ON h.ROWID = chj.handle_id
               WHERE c.guid = ?`,
            )
            .all(chat.platformId) as { id: string }[];
          return rows.map((r) => ({ id: r.id, name: r.id, isBot: false }));
        },

        async close() {
          closed = true;
          if (timer) clearTimeout(timer);
          try {
            db.close();
          } catch {}
        },
      };
    },
  };
}

// ---------------------------------------------------------------- database

export interface MessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  /** Milliseconds since 2001-01-01. Messages stores nanoseconds, too large for a JS number; SQL converts. */
  date: number;
  replyTo: string | null;
  sender: string | null;
  chatGuid: string;
  chatStyle: number;
  chatName: string | null;
  chatIdentifier: string | null;
}

interface AttachmentRow {
  filename: string | null;
  mime: string | null;
  name: string | null;
  size: number | null;
}

class PermissionError extends Error {}

function openDb(path: string): DatabaseSync {
  try {
    // SQLite only says "unable to open"; the file system says why. Without Full Disk Access it is EPERM.
    closeSync(openSync(path, "r"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") throw new PermissionError(`cannot read ${path}: ${code}`);
    throw error;
  }
  const db = new DatabaseSync(path, { readOnly: true });
  // Messages writes while we read; wait briefly instead of failing on a lock.
  db.exec("PRAGMA busy_timeout = 2000");
  // Opening is lazy; touch the schema so a missing permission shows up here.
  db.prepare("SELECT 1 FROM message LIMIT 1").get();
  return db;
}

/** The first row to read after: everything newer than `fromMs`. */
function startRow(db: DatabaseSync, fromMs: number): number {
  const row = db.prepare("SELECT IFNULL(MAX(ROWID), 0) AS n FROM message WHERE date < ?").get(toAppleDate(fromMs)) as {
    n: number;
  };
  return row.n;
}

/** Messages other people sent since `afterRow`. Tapbacks, edits and group events are skipped. */
function newMessages(db: DatabaseSync, afterRow: number): MessageRow[] {
  return db
    .prepare(
      `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
              CASE WHEN m.date > 1000000000000 THEN m.date / 1000000 ELSE m.date * 1000 END AS date,
              m.thread_originator_guid AS replyTo, h.id AS sender,
              c.guid AS chatGuid, c.style AS chatStyle, c.display_name AS chatName,
              c.chat_identifier AS chatIdentifier
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
       WHERE m.ROWID > ? AND m.is_from_me = 0
         AND IFNULL(m.associated_message_type, 0) = 0 AND IFNULL(m.item_type, 0) = 0
       ORDER BY m.ROWID LIMIT 200`,
    )
    .all(afterRow) as unknown as MessageRow[];
}

function attachmentsOf(db: DatabaseSync, rowid: number): AttachmentRow[] {
  return db
    .prepare(
      `SELECT a.filename AS filename, a.mime_type AS mime, a.transfer_name AS name, a.total_bytes AS size
       FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
       WHERE maj.message_id = ?`,
    )
    .all(rowid) as unknown as AttachmentRow[];
}

/** The handle this Mac's iMessage account sends from, as recorded on its own messages. */
function accountHandle(db: DatabaseSync): string | undefined {
  const row = db
    .prepare("SELECT account FROM message WHERE is_from_me = 1 AND account LIKE '_:%' ORDER BY ROWID DESC LIMIT 1")
    .get() as { account: string } | undefined;
  // `E:name@icloud.com` or `p:+15551234567`.
  return row ? normalizeHandle(row.account.slice(2)) : undefined;
}

// ----------------------------------------------------------------- mapping

/** Map one chat.db row to Mingle's inbound shape. Exported for tests. */
export function toInbound(
  row: MessageRow,
  attachments: readonly AttachmentRow[],
  me: { handle: string; name: string },
): InboundMessage | undefined {
  if (!row.sender) return undefined;
  const raw = row.text ?? (row.attributedBody ? decodeAttributedBody(row.attributedBody) : "") ?? "";
  // U+FFFC marks where an attachment sits in the text.
  let text = raw.replace(/￼/g, "").trim();
  const group = row.chatStyle === STYLE_GROUP;

  let addressed = !group;
  if (group) {
    const mentionedByAttribute = row.attributedBody ? mentionsHandle(row.attributedBody, me.handle) : false;
    const byName = me.name ? stripName(text, me.name) : undefined;
    if (byName !== undefined) text = byName;
    addressed = mentionedByAttribute || byName !== undefined;
  }

  const files: InboundAttachment[] = [];
  for (const a of attachments) {
    if (!a.filename) continue;
    files.push({
      id: a.filename,
      name: a.name ?? a.filename.split("/").pop() ?? "file",
      ...(a.size ? { size: a.size } : {}),
      ...(a.mime ? { mime: a.mime } : {}),
    });
  }
  if (!text && files.length === 0) return undefined;

  const name = row.chatName?.trim() || (group ? undefined : row.sender);
  return {
    platformId: row.guid,
    chat: { platformId: row.chatGuid, kind: group ? "group" : "dm", ...(name ? { name } : {}) },
    sender: { id: row.sender, name: row.sender, isBot: false },
    text,
    attachments: files,
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    addressedToBot: addressed,
    sentAt: fromAppleDate(row.date),
  };
}

/**
 * When `text` addresses the agent by name ("@Alex …", "Alex, …", "… @Alex"), the text without it.
 * iMessage mentions show the contact's name, so this covers mentions of an agent saved as a contact.
 */
export function stripName(text: string, name: string): string | undefined {
  const n = escapeRegExp(name.trim());
  if (!n) return undefined;
  const mention = new RegExp(`(^|\\s)@${n}(?=$|[\\s,，:：.!?！？])`, "iu");
  if (mention.test(text)) return tidy(text.replace(mention, "$1"));
  const leading = new RegExp(`^${n}(?:[\\s,，:：]+|$)`, "iu");
  if (leading.test(text)) return tidy(text.replace(leading, ""));
  return undefined;
}

function tidy(text: string): string {
  return text
    .replace(/^[\s,，:：]+/, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * The plain text inside an `attributedBody` (an NSAttributedString in Apple's typedstream format).
 * Recent macOS versions often leave `text` empty and keep only this. Exported for tests.
 */
export function decodeAttributedBody(blob: Uint8Array): string | undefined {
  const buf = Buffer.from(blob);
  const start = buf.indexOf("NSString");
  if (start < 0) return undefined;
  // After the class name: a few header bytes, then "+" and the string's length.
  const plus = buf.indexOf(0x2b, start + 8);
  if (plus < 0 || plus > start + 16) return undefined;
  let i = plus + 1;
  let length = buf[i] ?? 0;
  i += 1;
  if (length === 0x81) {
    length = buf.readUInt16LE(i);
    i += 2;
  } else if (length === 0x82) {
    length = buf.readUInt32LE(i);
    i += 4;
  }
  if (i + length > buf.length) return undefined;
  return buf.subarray(i, i + length).toString("utf8");
}

/** Whether a confirmed @-mention in the message points at `handle`. */
function mentionsHandle(blob: Uint8Array, handle: string): boolean {
  if (!handle) return false;
  const buf = Buffer.from(blob);
  return buf.includes("__kIMMentionConfirmedMention") && buf.includes(handle);
}

function fromAppleDate(ms: number): number {
  return APPLE_EPOCH_MS + ms;
}

/** Nanoseconds since 2001, as current macOS stores them. A bigint: the value does not fit a JS number. */
function toAppleDate(ms: number): bigint {
  return BigInt(Math.max(0, Math.round(ms - APPLE_EPOCH_MS))) * 1_000_000n;
}

// -------------------------------------------------------------- AppleScript

const SEND_TEXT_SCRIPT = `on run argv
  tell application "Messages" to send (item 1 of argv) to chat id (item 2 of argv)
end run`;

const SEND_FILE_SCRIPT = `on run argv
  tell application "Messages" to send (POSIX file (item 1 of argv)) to chat id (item 2 of argv)
end run`;

const SEND_TO_HANDLE_SCRIPT = `on run argv
  tell application "Messages"
    set svc to 1st account whose service type = iMessage
    send (item 1 of argv) to participant (item 2 of argv) of svc
  end tell
end run`;

/** The signed-in iMessage account, or nothing when there is none. */
const ACCOUNT_SCRIPT = `tell application "Messages"
  set found to (every account whose service type = iMessage)
  if found is {} then return ""
  try
    return description of item 1 of found
  on error
    return "iMessage"
  end try
end tell`;

function osascript(script: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script, ...args], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = (error as { killed?: boolean }).killed === true;
        reject(new ScriptError(String(stderr || error.message).trim(), timedOut));
      } else resolve(String(stdout));
    });
  });
}

function sendFailure(error: unknown): SendResult {
  if (error instanceof ScriptError) {
    if (error.timedOut) return { kind: "uncertain" };
    if (isAutomationDenied(error)) return { kind: "failed", code: "forbidden", retryable: false };
    if (/Can.t get chat id|Invalid key form|-1728/.test(error.message))
      return { kind: "failed", code: "chat_gone", retryable: false };
    if (/-1712|timed out/i.test(error.message)) return { kind: "uncertain" };
  }
  return { kind: "failed", code: "unknown", retryable: false };
}

/** macOS refused to let us control Messages ("Not authorized to send Apple events", -1743). */
function isAutomationDenied(error: unknown): boolean {
  return /-1743|not authori[sz]ed/i.test((error as Error)?.message ?? "");
}

/** Reading chat.db without Full Disk Access. */
function isPermissionError(error: unknown): boolean {
  return error instanceof PermissionError || (error as { errcode?: number })?.errcode === 23; // SQLITE_AUTH
}

// ------------------------------------------------------------------- helpers

/** A phone number (with country code) or an email address, as Messages records it; else undefined. */
export function normalizeHandle(value: string): string | undefined {
  const v = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v.toLowerCase();
  const digits = v.replace(/[\s\-().]/g, "");
  if (/^\+\d{6,15}$/.test(digits)) return digits;
  return undefined;
}

function sameHandle(a: string, b: string | undefined): boolean {
  return Boolean(b) && a.toLowerCase() === normalizeHandle(b ?? "")?.toLowerCase();
}

/** Mingle's progress and answers use light Markdown; Messages shows plain text. */
export function plain(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "");
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
