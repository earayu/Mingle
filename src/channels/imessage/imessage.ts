import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, statSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BotIdentity,
  Capabilities,
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChannelSetup,
  InboundAttachment,
  InboundMessage,
  OutboundMessage,
  Sender,
  SendResult,
} from "../channel.ts";
import { withTextSent } from "../channel.ts";

/**
 * iMessage through the Messages app on this Mac, signed in to the owner's own Apple ID
 * (docs/spec.md 6.6). The owner talks to the agent in their chat with themselves; nothing
 * anyone else sends is read.
 *
 * Receiving: poll the local Messages database (`~/Library/Messages/chat.db`, read-only; needs Full
 * Disk Access). Sending: AppleScript to Messages (macOS asks once for permission to control it).
 *
 * In the self-chat everything is "from me", the owner's words and the agent's alike. The agent's
 * messages end with an invisible marker and are remembered when sent, so they are never read back
 * as the owner's.
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
  /** Setup checks (docs/spec.md 6.6). Defaults read this Mac. */
  readonly setup?: SetupProbe;
}

/** How the setup checks look at this Mac, replaceable in tests. */
export interface SetupProbe {
  /** iMessage accounts Messages has turned on, read from its preferences (no permission needed). */
  readonly activeAccounts?: () => Promise<number | undefined>;
  /** The user's privacy database; readable only with Full Disk Access. */
  readonly tccPath?: string;
  /** The app macOS holds responsible for this process: the one permissions are granted to. */
  readonly bundleId?: string;
  readonly appPath?: (bundleId: string) => Promise<string | undefined>;
  /** Runs `open` with these arguments. */
  readonly open?: (args: readonly string[]) => Promise<void>;
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

/** Milliseconds between 1970-01-01 and 2001-01-01, the epoch Messages counts from. */
const APPLE_EPOCH_MS = 978_307_200_000;
/** On connect, messages this recent are delivered again; the core drops the ones it already has. */
const BACKFILL_MS = 10 * 60_000;
/** Ends every message the agent sends: zero width space + word joiner. Invisible, survives Messages. */
export const AGENT_MARK = "​⁠";
/** What the agent sent is remembered this long, in case a marker is ever lost. */
const ECHO_MS = 10 * 60_000;
/** The same words seen as sent and as received within this window are one message (the phone's copy). */
const TWIN_MS = 60_000;

export function imessageChannel(options: IMessageOptions = {}): Channel {
  const dbPath = options.dbPath ?? join(homedir(), "Library", "Messages", "chat.db");
  const runScript = options.runScript ?? osascript;
  const pollMs = options.pollMs ?? 1000;
  const sentLookupMs = options.sentLookupMs ?? 5000;
  const now = options.now ?? Date.now;

  return {
    platform: "imessage",
    onboarding: { kind: "credentials", fields: [] },
    setup: imessageSetup(dbPath, runScript, options.setup ?? {}),

    async *onboard() {
      let fromDb: string[];
      try {
        const db = openDb(dbPath);
        try {
          fromDb = callerIds(db);
        } finally {
          db.close();
        }
      } catch (error) {
        yield { kind: "failed", code: isPermissionError(error) ? "permission_missing" : "unknown" };
        return;
      }
      // Asks macOS for permission to control Messages now, while the person is at the console.
      let accounts: string[];
      try {
        accounts = parseAccounts(await runScript(ACCOUNT_SCRIPT, [], 60_000));
      } catch (error) {
        yield { kind: "failed", code: isAutomationDenied(error) ? "permission_missing" : "unknown" };
        return;
      }
      const handle = accounts[0];
      if (!handle) {
        yield { kind: "failed", code: "not_signed_in" };
        return;
      }
      const handles = [...new Set([...accounts, ...fromDb])];
      yield {
        kind: "succeeded",
        credentials: { handle, handles: handles.join(","), since: String(now()) },
        bot: { id: handle, name: handle },
        ownerId: handle,
      };
    },

    async connect(credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const handle = credentials.handle ?? "";
      const since = Number(credentials.since ?? 0);
      const bot: BotIdentity = { id: handle, name: handle };
      const owner: Sender = { id: handle, name: handle, isBot: false };
      let db: DatabaseSync;
      try {
        db = openDb(dbPath);
      } catch (error) {
        // Without Full Disk Access only the person can help; anything else the core retries.
        if (isPermissionError(error)) events.onState({ kind: "error", code: "permission_missing" });
        throw error;
      }
      // Every address of this account: the Apple ID email and the phone number reach the same person.
      const handles = new Set(
        [handle, ...(credentials.handles ?? "").split(","), ...callerIds(db)].filter(Boolean).map(lower),
      );
      let lastRowId = startRow(db, Math.max(since, now() - BACKFILL_MS));
      // An open handle keeps reading a file that was moved or replaced; watch the path itself.
      let inode = statSync(dbPath).ino;
      let closed = false;
      let failures = 0;
      let timer: NodeJS.Timeout | undefined;

      /** Text the agent sent, and the files it is sending, so their rows are not taken for the owner's. */
      const sentTexts: { text: string; at: number }[] = [];
      const sendingFiles = new Map<string, number>();
      /** Recent owner messages, to drop the second copy when the phone's message shows up twice. */
      const seen: { text: string; fromMe: boolean; at: number }[] = [];

      const isAgents = (row: SelfRow, text: string, files: readonly AttachmentRow[]): boolean => {
        const t = now();
        prune(sentTexts, t - ECHO_MS);
        const marked = text.endsWith(AGENT_MARK);
        // Each sent text explains one row, so the owner can still say the same words later.
        const words = (marked ? text.slice(0, -AGENT_MARK.length) : text).trim();
        const i = row.fromMe && words ? sentTexts.findIndex((s) => s.text === words) : -1;
        if (i >= 0) sentTexts.splice(i, 1);
        if (marked || i >= 0) return true;
        if (row.fromMe && !text.replace(/￼/g, "").trim() && files.length > 0) {
          for (const [name, until] of sendingFiles) if (until < t) sendingFiles.delete(name);
          return files.every((f) => f.name && sendingFiles.has(f.name));
        }
        return false;
      };

      const isTwin = (row: SelfRow, text: string): boolean => {
        const at = fromAppleDate(row.date);
        prune(seen, now() - 5 * TWIN_MS);
        if (!text) return false;
        // Each copy pairs with one other, so saying the same thing again still counts.
        const i = seen.findIndex((s) => s.text === text && s.fromMe !== row.fromMe && Math.abs(s.at - at) < TWIN_MS);
        if (i >= 0) {
          seen.splice(i, 1);
          return true;
        }
        seen.push({ text, fromMe: row.fromMe, at });
        return false;
      };

      const read = () => {
        for (const row of selfMessages(db, lastRowId, handles)) {
          lastRowId = Math.max(lastRowId, row.rowid);
          const raw = rowText(row);
          const files = attachmentsOf(db, row.rowid);
          if (isAgents(row, raw, files)) continue;
          if (isTwin(row, raw)) continue;
          const inbound = toInbound(row, raw, files, owner);
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

      /** Mark and remember a text before it goes out, so the poller never mistakes it for the owner. */
      const outgoing = (markdown: string): string => {
        const text = plain(markdown).trim();
        sentTexts.push({ text, at: now() });
        return `${text}${AGENT_MARK}`;
      };

      return {
        bot,
        ownerOnly: true,
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          const chatGuid = message.chat.platformId;
          const before = maxRow();
          const degraded: ("quote_dropped" | "markdown_flattened")[] = [];
          if (message.replyTo) degraded.push("quote_dropped");
          if (plain(message.text) !== message.text) degraded.push("markdown_flattened");
          let textId = "";
          try {
            if (message.text.trim()) {
              await runScript(SEND_TEXT_SCRIPT, [outgoing(message.text), chatGuid], 30_000);
              textId = `local:${now()}`;
            }
            for (const file of message.files ?? []) {
              const name = file.name ?? basename(file.path);
              sendingFiles.set(name, now() + ECHO_MS);
              await runScript(SEND_FILE_SCRIPT, [await stage(dbPath, file.path, name), chatGuid], 120_000);
            }
          } catch (error) {
            return withTextSent(sendFailure(error), textId);
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
          await runScript(SEND_TO_HANDLE_SCRIPT, [outgoing(text), userId], 30_000);
        },

        async listMembers() {
          return [owner];
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

// ------------------------------------------------------------------- setup

const SETTINGS_PANES: Readonly<Record<string, string>> = {
  open_full_disk_access: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
  open_automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
};

/**
 * What the connect screen checks every few seconds, in the order the person does it: Messages
 * signed in to iMessage, Full Disk Access, permission to control Messages. None of the checks
 * makes macOS ask anything; only "allow_automation", clicked by the person, does.
 */
function imessageSetup(dbPath: string, runScript: ScriptRunner, probe: SetupProbe): ChannelSetup {
  const activeAccounts = probe.activeAccounts ?? readActiveAccounts;
  const tccPath = probe.tccPath ?? join(homedir(), "Library", "Application Support", "com.apple.TCC", "TCC.db");
  const bundleId = probe.bundleId ?? process.env.__CFBundleIdentifier;
  const appPath = probe.appPath ?? findApp;
  const open = probe.open ?? openWith;
  /** Set once controlling Messages worked here, in case the privacy database cannot be read. */
  let allowed = false;
  let signedIn = false;
  let app: { path?: string; name: string } | undefined;

  const appInfo = async () => {
    if (app) return app;
    const path = bundleId ? await appPath(bundleId).catch(() => undefined) : undefined;
    // Without an app (started by launchd or over SSH), macOS asks about the Node.js binary itself.
    app = path
      ? { path, name: basename(path).replace(/\.app$/, "") }
      : { path: process.execPath, name: basename(process.execPath) };
    return app;
  };

  return {
    actions: ["open_messages", "open_full_disk_access", "open_automation", "reveal_app", "allow_automation"],

    async check() {
      const accounts = await activeAccounts().catch(() => undefined);
      const signedInState = signedIn || (accounts ?? 0) > 0 ? "ok" : accounts === undefined ? "unknown" : "missing";
      let disk: "ok" | "missing" | "unknown";
      try {
        openDb(dbPath).close();
        disk = "ok";
      } catch (error) {
        // No database at all means Messages was never opened; the first check says what to do.
        disk = isPermissionError(error) ? "missing" : "unknown";
      }
      let automation: "ok" | "missing" | "denied" | "unknown" = disk === "ok" ? "missing" : "unknown";
      if (allowed) automation = "ok";
      else if (disk === "ok") automation = automationState(tccPath, bundleId) ?? "missing";
      return {
        checks: [
          { id: "signed_in", state: signedInState },
          { id: "full_disk_access", state: disk },
          { id: "automation", state: automation },
        ],
        app: (await appInfo()).name,
      };
    },

    async act(action) {
      if (action === "open_messages") return open(["-a", "Messages"]);
      const pane = SETTINGS_PANES[action];
      if (pane) return open([pane]);
      if (action === "reveal_app") {
        const { path } = await appInfo();
        if (path) await open(["-R", path]);
        return;
      }
      if (action === "allow_automation") {
        // macOS shows its "allow to control Messages" prompt now; the call returns once answered.
        try {
          signedIn = parseAccounts(await runScript(ACCOUNT_SCRIPT, [], 120_000)).length > 0;
          allowed = true;
        } catch (error) {
          if (!isAutomationDenied(error)) throw error;
        }
      }
    },
  };
}

/** Permission to control Messages, as the privacy database records it for this app. */
function automationState(tccPath: string, bundleId: string | undefined): "ok" | "denied" | undefined {
  let rows: { client: string; auth_value: number }[];
  try {
    const db = new DatabaseSync(tccPath, { readOnly: true });
    try {
      rows = db
        .prepare(
          "SELECT client, auth_value FROM access WHERE service = 'kTCCServiceAppleEvents' AND indirect_object_identifier = 'com.apple.MobileSMS'",
        )
        .all() as { client: string; auth_value: number }[];
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
  // Without knowing which app we run under, any app allowed is the best guess; connecting confirms it.
  const ours = bundleId ? rows.filter((r) => r.client === bundleId) : rows;
  if (ours.some((r) => r.auth_value === 2)) return "ok";
  if (ours.some((r) => r.auth_value === 0)) return "denied";
  return undefined;
}

/** How many iMessage accounts Messages has active. Undefined when the preferences cannot be read. */
function readActiveAccounts(): Promise<number | undefined> {
  return new Promise((resolve) => {
    execFile(
      "defaults",
      ["read", "com.apple.imservice.ids.iMessage", "ActiveAccounts"],
      { timeout: 5000 },
      (error, stdout, stderr) => {
        // Never signed in on this Mac: the key or the whole domain is missing.
        if (error) resolve(/does not exist/.test(String(stderr)) ? 0 : undefined);
        else resolve(countActiveAccounts(String(stdout)));
      },
    );
  });
}

/** `defaults read` prints `(\n    "6F1C…"\n)`; each quoted or bare entry is one account. */
export function countActiveAccounts(output: string): number {
  return output
    .replace(/[()]/g, "")
    .split(/[,\n]/)
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean).length;
}

function findApp(bundleId: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "mdfind",
      [`kMDItemCFBundleIdentifier == "${bundleId.replace(/["\\]/g, "")}"`],
      { timeout: 3000 },
      (error, stdout) =>
        resolve(
          error
            ? undefined
            : String(stdout)
                .split("\n")
                .find((l) => l.endsWith(".app")),
        ),
    );
  });
}

function openWith(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("open", [...args], { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

// ---------------------------------------------------------------- database

export interface SelfRow {
  rowid: number;
  guid: string;
  text: string | null;
  attributedBody: Uint8Array | null;
  /** Milliseconds since 2001-01-01. Messages stores nanoseconds, too large for a JS number; SQL converts. */
  date: number;
  fromMe: boolean;
  chatGuid: string;
}

export interface AttachmentRow {
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

/** New messages in this account's chats with itself. Tapbacks, edits and system rows are skipped. */
function selfMessages(db: DatabaseSync, afterRow: number, handles: ReadonlySet<string>): SelfRow[] {
  const list = [...handles];
  if (list.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text, m.attributedBody AS attributedBody,
              CASE WHEN m.date > 1000000000000 THEN m.date / 1000000 ELSE m.date * 1000 END AS date,
              m.is_from_me AS fromMe, c.guid AS chatGuid
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       WHERE m.ROWID > ? AND c.style = 45 AND lower(c.chat_identifier) IN (${list.map(() => "?").join(",")})
         AND IFNULL(m.associated_message_type, 0) = 0 AND IFNULL(m.item_type, 0) = 0
       ORDER BY m.ROWID LIMIT 200`,
    )
    .all(afterRow, ...list) as unknown as (Omit<SelfRow, "fromMe"> & { fromMe: number })[];
  return rows.map((r) => ({ ...r, fromMe: r.fromMe === 1 }));
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

/** The addresses this account has sent from (its phone number, often). */
function callerIds(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT destination_caller_id AS id FROM message
       WHERE is_from_me = 1 AND service = 'iMessage' AND destination_caller_id IS NOT NULL`,
    )
    .all() as { id: string }[];
  return rows.map((r) => r.id).filter((id) => id.length > 0);
}

// ----------------------------------------------------------------- mapping

function rowText(row: SelfRow): string {
  return row.text ?? (row.attributedBody ? decodeAttributedBody(row.attributedBody) : undefined) ?? "";
}

/** Map one self-chat row to Mingle's inbound shape: always the owner, always addressed. Exported for tests. */
export function toInbound(
  row: SelfRow,
  raw: string,
  attachments: readonly AttachmentRow[],
  owner: Sender,
): InboundMessage | undefined {
  // U+FFFC marks where an attachment sits in the text.
  const text = raw.replace(/￼/g, "").trim();
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
  return {
    platformId: row.guid,
    chat: { platformId: row.chatGuid, kind: "dm", name: owner.name },
    sender: owner,
    text,
    attachments: files,
    addressedToBot: true,
    sentAt: fromAppleDate(row.date),
  };
}

/**
 * The plain text inside an `attributedBody` (an NSAttributedString in Apple's typedstream format).
 * Recent macOS versions leave `text` empty and keep only this. Exported for tests.
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

/** The signed-in iMessage accounts' descriptions ("E:name@icloud.com"), one per line. */
const ACCOUNT_SCRIPT = `tell application "Messages"
  set out to ""
  repeat with a in (every account whose service type = iMessage)
    try
      set out to out & (description of a) & linefeed
    end try
  end repeat
  return out
end tell`;

/** "E:name@icloud.com" / "P:+8613800000000" lines → handles. */
export function parseAccounts(output: string): string[] {
  const handles = output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[EPep]:/, ""))
    .filter((h) => /@|^\+?\d{5,}$/.test(h))
    .map(lower);
  return [...new Set(handles)];
}

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

/**
 * Messages only sends files from its own attachments folder: from anywhere else it posts an empty
 * bubble and reports success (seen on macOS 14.5). Copy the file there first; Messages keeps it.
 */
async function stage(dbPath: string, path: string, name: string): Promise<string> {
  const dir = join(dirname(dbPath), "Attachments", "mingle", randomUUID());
  await mkdir(dir, { recursive: true });
  const staged = join(dir, name.replace(/[/\\]/g, "_"));
  await copyFile(path, staged);
  return staged;
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

function prune<T extends { at: number }>(list: T[], before: number): void {
  while (list.length && (list[0]?.at ?? 0) < before) list.shift();
}

function lower(s: string): string {
  return s.trim().toLowerCase();
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
