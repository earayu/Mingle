import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ChatKind, Platform } from "../channels/channel.ts";
import type { HearTier } from "../core/hearing.ts";
import { shortId } from "../core/ids.ts";
import { INBOUND, type InboundEvent } from "../core/inbound.ts";
import { searchTerms } from "../core/terms.ts";

export type AgentStatus = "offline" | "idle" | "thinking" | "working" | "error" | "paused";
export type ConnectionStateKind = "awaiting_credentials" | "awaiting_approval" | "connected" | "reconnecting" | "error";
export type InboundState =
  | "received"
  | "delivered"
  | "waiting"
  | "replied"
  | "unanswered"
  | "failed"
  | "ignored"
  /** From someone the owner has not let in yet (docs/spec.md 4.7). */
  | "held";
export type OutboundState = "pending" | "sent" | "failed" | "uncertain";
export type TaskStatus = "todo" | "in_progress" | "done" | "closed";

export interface Agent {
  id: string;
  slug: string;
  name: string;
  /** The picture's file name under ~/.mingle/avatars/, or null for the generated initial. */
  avatar: string | null;
  harness: string;
  model: string | null;
  sessionId: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  /** With status "error": the failure class (auth, quota, ...), or null when it is not known. */
  statusFailure: string | null;
  /** Whether this agent has ever successfully sent a message. */
  hasReplied: boolean;
  /** Ask the owner about new people and groups on every chat app, not only public ones (docs/spec.md 4.7). */
  askAll: boolean;
  /** Give the agent a daily turn to tidy its memory while it is idle (docs/spec.md 4.5). */
  tidy: boolean;
  createdAt: number;
}

/** Whether a person or group may put the agent to work: null until decided (docs/spec.md 4.7). */
export type Access = "allowed" | "blocked" | null;
/** What the owner handed an agent from another conversation (docs/spec.md 4.12). */
export interface Handoff {
  id: string;
  agentId: string;
  body: string;
  via: "command" | "paste";
  state: "waiting" | "delivered";
  createdAt: number;
  deliveredAt: number | null;
}

/** An agent's environment variable as stored: its name only. */
export interface EnvName {
  name: string;
  updatedAt: number;
}

export interface Connection {
  id: string;
  agentId: string;
  platform: Platform;
  botId: string | null;
  botName: string | null;
  state: ConnectionStateKind;
  stateDetail: string | null;
  secretRef: string | null;
  ownerId: string | null;
  /** The one-time code that makes whoever sends it the owner, while the bot has none (docs/spec.md 4.7). */
  claimCode: string | null;
  claimExpiresAt: number | null;
}

/** One person as one bot sees them: the agent's address book (docs/spec.md 3). */
export interface Contact {
  id: string;
  connectionId: string;
  platformId: string;
  /** The latest name the platform reported. */
  name: string | null;
  /** The name the owner or the agent gave them. Wins over `name`. */
  alias: string | null;
  access: Access;
  /** A bot: the platform or a local agent said so, or the owner marked it (docs/spec.md 4.2). */
  isBot: boolean;
  /** The person this account belongs to, when someone linked it or wrote a note about them. */
  personId: string | null;
  /** The person's name, which wins over the contact's own. */
  personName: string | null;
  /** Who put it in its person. Only the owner's links may carry anything beyond a name and a note. */
  linkedBy: LinkedBy | null;
  /** Their department and title as the chat app reports them, where member profiles are on. */
  profile: string | null;
  updatedAt: number;
}

export type LinkedBy = "owner" | "agent";

/** One human across the agent's chat apps (docs/spec.md 4.2). */
export interface Person {
  id: string;
  agentId: string;
  name: string | null;
  note: string | null;
  updatedAt: number;
}

/** What to call a contact: the person's name, else the given one, else the platform's, else nothing. */
export function contactName(
  contact: (Pick<Contact, "name" | "alias"> & { personName?: string | null }) | undefined,
): string | null {
  return contact?.personName || contact?.alias || contact?.name || null;
}

/** Contacts with their person's name. */
const CONTACTS = "SELECT k.*, p.name AS person_name FROM contacts k LEFT JOIN people p ON p.id = k.person_id";

/**
 * How often a group that hears everything reaches the agent: Mingle's own pace (`auto`), at most once
 * per `ms` (`every`), or not at all until someone addresses the agent there (`muted`).
 */
export type HearPace =
  | { readonly kind: "auto" }
  | { readonly kind: "every"; readonly ms: number }
  | { readonly kind: "muted" };

export interface Chat {
  id: string;
  connectionId: string;
  platformId: string;
  kind: ChatKind;
  name: string | null;
  /** The chat this thread belongs to, whose messages are its background. */
  parentId: string | null;
  /** Groups only: whether the owner let this group in. */
  access: Access;
  /** Groups only: the owner set it to hear every message, not only those addressed to the agent (docs/spec.md 4.2). */
  listen: boolean;
  /** Groups only: how often what it hears reaches the agent, as the agent set it (docs/spec.md 4.2). */
  hearPace: HearPace;
  /** Groups only: how fast it keeps up with a conversation there, as the owner chose; null follows the group's size. */
  hearTier: HearTier | null;
  /** Groups only: other names that count as calling the agent there (docs/spec.md 4.2). */
  aliases: string[];
  /** Direct chats only: the other person's ID on the platform, when known. */
  peerId: string | null;
}

export interface Attachment {
  id: string;
  ref: string;
  name: string;
  size?: number;
  mime?: string;
}

export interface Message {
  id: string;
  chatId: string;
  direction: "in" | "out";
  platformId: string | null;
  senderId: string | null;
  senderName: string | null;
  body: string;
  attachments: Attachment[];
  replyTo: string | null;
  triggers: boolean;
  state: InboundState | OutboundState;
  createdAt: number;
  /** Inbound, while `waiting`: when Mingle delivers it again. */
  retryAt?: number | null;
  /** Outbound: Mingle's own words in the chat, not the agent's (docs/spec.md 4.7). */
  notice?: boolean;
  /** The task whose line sent it, or a follow-up Mingle handed to that line (docs/spec.md 4.13). */
  lineTaskId?: string | null;
}

/** Where a task's line is (docs/spec.md 4.13); null for a task that is only a note. */
export type LineState = "queued" | "running" | "idle" | "ended" | "error";

export interface Task {
  id: string;
  agentId: string;
  title: string;
  status: TaskStatus;
  fromMessage: string | null;
  fromChat: string | null;
  /** A task the agent works on in a line of its own (docs/spec.md 4.13). */
  lineState: LineState | null;
  sessionId: string | null;
  brief: string | null;
  /** What the line reported when it finished. */
  summary: string | null;
  lineError: string | null;
  /**
   * The thread the line talks in (docs/spec.md 4.13): opened under the message it works for, or the
   * thread that message was already in. Null where there is none.
   */
  threadChat: string | null;
  /** How far the line is, in one line: the latest it said in its thread or reported with `task status`. */
  progress: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Reminder {
  id: string;
  agentId: string;
  body: string;
  rule: string;
  timezone: string;
  chatId: string | null;
  /** The message the reminder was set for; when it fires, the agent sees it quoted. */
  sourceMessageId: string | null;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  createdAt: number;
  /** A shell command Mingle runs on the rule; the reminder fires only when its output changes. */
  check: ReminderCheck | null;
}

/** The check of a reminder that fires on change (docs/spec.md 4.6). */
export interface ReminderCheck {
  command: string;
  /** Ends after the first change. */
  once: boolean;
  /** SHA-256 of the trimmed output it compares against; the output itself is never stored. */
  hash: string | null;
  /** Failed runs in a row; 0 after a run that worked. */
  failures: number;
  /** Why the last run failed, while it keeps failing. */
  error: string | null;
  lastCheckedAt: number | null;
  /** When it stops checking (docs/spec.md 4.6). */
  until: number | null;
}

type Row = Record<string, SQLInputValue>;

const MIGRATIONS = new URL("./migrations/", import.meta.url);

/** All SQLite access. Synchronous by design: node:sqlite is, and the process is single-threaded. */
export class Store {
  readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const from = this.migrate();
    if (from < 6) this.backfillContacts();
  }

  close(): void {
    this.db.close();
  }

  /** Apply pending migrations. Returns the version the database was at before. */
  private migrate(): number {
    const current = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
    const files = readdirSync(MIGRATIONS)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    for (const file of files) {
      const version = Number.parseInt(file, 10);
      if (version <= current) continue;
      const sql = readFileSync(new URL(file, MIGRATIONS), "utf8");
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${version}`);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    return current;
  }

  /** On upgrade to contacts: everyone who already wrote, and every known owner, gets an entry. */
  private backfillContacts(): void {
    const senders = this.db
      .prepare(
        `SELECT c.connection_id, m.sender_id,
           (SELECT m2.sender_name FROM messages m2 JOIN chats c2 ON c2.id = m2.chat_id
            WHERE c2.connection_id = c.connection_id AND m2.sender_id = m.sender_id
              AND m2.sender_name IS NOT NULL AND m2.sender_name <> '' AND m2.sender_name <> m2.sender_id
            ORDER BY m2.created_at DESC LIMIT 1) AS name
         FROM messages m JOIN chats c ON c.id = m.chat_id
         WHERE m.direction = 'in' AND m.sender_id IS NOT NULL
         GROUP BY c.connection_id, m.sender_id`,
      )
      .all() as Row[];
    // They were talking to the agent before Mingle asked about anyone: they stay let in (docs/spec.md 4.7).
    for (const r of senders) {
      const contact = this.touchContact(String(r.connection_id), String(r.sender_id), str(r.name));
      this.setContactAccess(contact.id, "allowed");
    }
    const owners = this.db.prepare("SELECT id, owner_id FROM connections WHERE owner_id IS NOT NULL").all() as Row[];
    for (const r of owners) this.touchContact(String(r.id), String(r.owner_id), null);
  }

  /** Mint an ID not yet used in `table`. */
  private mint(table: string, prefix: string, length: number): string {
    for (let i = 0; i < 20; i++) {
      const id = shortId(prefix, length);
      if (!this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
    }
    return shortId(prefix, length + 3);
  }

  // ------------------------------------------------------------------ agents

  createAgent(input: { name: string; slug: string; harness: string; model?: string | null }): Agent {
    const id = this.mint("agents", "a", 6);
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO agents (id, slug, name, harness, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.slug, input.name, input.harness, input.model ?? null, t, t);
    return this.agent(id) as Agent;
  }

  agent(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ? OR slug = ?").get(id, id) as Row | undefined;
    return row && toAgent(row);
  }

  agents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Row[]).map(toAgent);
  }

  setAgentStatus(id: string, status: AgentStatus, detail: string | null = null, failure: string | null = null): void {
    this.db
      .prepare("UPDATE agents SET status = ?, status_detail = ?, status_failure = ?, updated_at = ? WHERE id = ?")
      .run(status, detail, failure, this.now(), id);
  }

  updateAgent(id: string, patch: { name?: string; harness?: string; model?: string | null }): void {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    for (const [column, value] of Object.entries(patch)) {
      if (value === undefined || !["name", "harness", "model"].includes(column)) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE agents SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, this.now(), id);
  }

  setAskAll(id: string, on: boolean): void {
    this.db.prepare("UPDATE agents SET ask_all = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, this.now(), id);
  }

  setTidy(id: string, on: boolean): void {
    this.db.prepare("UPDATE agents SET tidy = ?, updated_at = ? WHERE id = ?").run(on ? 1 : 0, this.now(), id);
  }

  /** When the agent was last given its memory tidy-up (docs/spec.md 4.5), or null if never. */
  tidyAt(id: string): number | null {
    const row = this.db.prepare("SELECT tidy_at FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row?.tidy_at == null ? null : Number(row.tidy_at);
  }

  setTidyAt(id: string, at: number): void {
    this.db.prepare("UPDATE agents SET tidy_at = ? WHERE id = ?").run(at, id);
  }

  /** When the agent's running turn began, or null when none runs (docs/spec.md 7.1). */
  turnAt(id: string): number | null {
    const row = this.db.prepare("SELECT turn_at FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row?.turn_at == null ? null : Number(row.turn_at);
  }

  setTurnAt(id: string, at: number | null): void {
    this.db.prepare("UPDATE agents SET turn_at = ? WHERE id = ?").run(at, id);
  }

  setAvatar(id: string, file: string | null): void {
    this.db.prepare("UPDATE agents SET avatar = ?, updated_at = ? WHERE id = ?").run(file, this.now(), id);
  }

  /** The last MEMORY.md size hint given to this agent (docs/spec.md 4.5), if any. */
  memoryHint(id: string): { at: number; size: number } | undefined {
    const row = this.db.prepare("SELECT memory_hint_at, memory_hint_size FROM agents WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (row?.memory_hint_at == null) return undefined;
    return { at: Number(row.memory_hint_at), size: Number(row.memory_hint_size) };
  }

  /** Record the hint just given, or forget it (null) once MEMORY.md is back under the limit. */
  setMemoryHint(id: string, at: number | null, size: number | null): void {
    this.db.prepare("UPDATE agents SET memory_hint_at = ?, memory_hint_size = ? WHERE id = ?").run(at, size, id);
  }

  /** A provider quota holds back everything new for this agent until `until` (docs/spec.md 4.3). */
  /** A usage-limit wait in force for this agent; `resetsAt` is null when the harness did not report one. */
  quotaWait(id: string): { until: number; resetsAt: number | null } | undefined {
    const row = this.db.prepare("SELECT quota_wait_until, quota_resets_at FROM agents WHERE id = ?").get(id) as
      | Row
      | undefined;
    if (row?.quota_wait_until == null) return undefined;
    return {
      until: Number(row.quota_wait_until),
      resetsAt: row.quota_resets_at == null ? null : Number(row.quota_resets_at),
    };
  }

  setQuotaWait(id: string, wait?: { until: number; resetsAt: number | null }): void {
    this.db
      .prepare("UPDATE agents SET quota_wait_until = ?, quota_resets_at = ? WHERE id = ?")
      .run(wait?.until ?? null, wait?.resetsAt ?? null, id);
  }

  /**
   * Pull every waiting inbound message's retry time of this agent forward to `now`, so a check
   * for due messages picks them up even while their chat app is offline. Only the timestamp
   * moves: terminal states, holds and content are untouched.
   */
  readyWaiting(agentId: string, now: number): void {
    this.db
      .prepare(
        `UPDATE messages SET retry_at = min(retry_at, ?)
         WHERE direction = 'in' AND state = 'waiting' AND chat_id IN
         (SELECT c.id FROM chats c JOIN connections n ON n.id = c.connection_id WHERE n.agent_id = ?)`,
      )
      .run(now, agentId);
  }

  setSessionId(id: string, sessionId: string | null): void {
    this.db.prepare("UPDATE agents SET session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, this.now(), id);
  }

  /**
   * A cold start opened `sessionId` in place of the agent's current session, which is kept as the
   * previous one so the switch can be undone (docs/spec.md 4.1).
   */
  replaceSession(id: string, sessionId: string): void {
    this.db
      .prepare("UPDATE agents SET previous_session_id = session_id, session_id = ?, updated_at = ? WHERE id = ?")
      .run(sessionId, this.now(), id);
  }

  /** The session the last cold start replaced; null when there was none. */
  previousSessionId(id: string): string | null {
    const row = this.db.prepare("SELECT previous_session_id FROM agents WHERE id = ?").get(id) as Row | undefined;
    return str(row?.previous_session_id);
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // --------------------------------------------------------------- agent env

  /** The names of an agent's environment variables, by name. Values are in the secret store. */
  envNames(agentId: string): EnvName[] {
    return (
      this.db.prepare("SELECT name, updated_at FROM agent_env WHERE agent_id = ? ORDER BY name").all(agentId) as Row[]
    ).map((r) => ({ name: String(r.name), updatedAt: Number(r.updated_at) }));
  }

  putEnvName(agentId: string, name: string): void {
    this.db
      .prepare(
        "INSERT INTO agent_env (agent_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT (agent_id, name) DO UPDATE SET updated_at = excluded.updated_at",
      )
      .run(agentId, name, this.now());
  }

  deleteEnvName(agentId: string, name: string): boolean {
    return this.db.prepare("DELETE FROM agent_env WHERE agent_id = ? AND name = ?").run(agentId, name).changes > 0;
  }

  // ------------------------------------------------------------- connections

  createConnection(input: { agentId: string; platform: Platform; secretRef: string }): Connection {
    const id = this.mint("connections", "n", 6);
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO connections (id, agent_id, platform, state, secret_ref, created_at, updated_at) VALUES (?, ?, ?, 'awaiting_credentials', ?, ?, ?)",
      )
      .run(id, input.agentId, input.platform, input.secretRef, t, t);
    return this.connection(id) as Connection;
  }

  connection(id: string): Connection | undefined {
    const row = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    return row && toConnection(row);
  }

  connections(agentId?: string): Connection[] {
    const rows = agentId
      ? this.db.prepare("SELECT * FROM connections WHERE agent_id = ? ORDER BY created_at").all(agentId)
      : this.db.prepare("SELECT * FROM connections ORDER BY created_at").all();
    return (rows as Row[]).map(toConnection);
  }

  updateConnection(
    id: string,
    patch: Partial<
      Pick<Connection, "botId" | "botName" | "state" | "stateDetail" | "ownerId" | "claimCode" | "claimExpiresAt">
    >,
  ): void {
    const columns: Record<string, string> = {
      botId: "bot_id",
      botName: "bot_name",
      state: "state",
      stateDetail: "state_detail",
      ownerId: "owner_id",
      claimCode: "claim_code",
      claimExpiresAt: "claim_expires_at",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${columns[k]} = ?`).join(", ");
    const params: SQLInputValue[] = [...entries.map(([, v]) => v as SQLInputValue), this.now(), id];
    this.db.prepare(`UPDATE connections SET ${sets}, updated_at = ? WHERE id = ?`).run(...params);
  }

  deleteConnection(id: string): void {
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
  }

  // ------------------------------------------------------------------- chats

  upsertChat(input: {
    connectionId: string;
    platformId: string;
    kind: ChatKind;
    name?: string | undefined;
    parentId?: string | undefined;
    /** Direct chats: the other person. */
    peerId?: string | undefined;
  }): Chat {
    const existing = this.db
      .prepare("SELECT * FROM chats WHERE connection_id = ? AND platform_id = ?")
      .get(input.connectionId, input.platformId) as Row | undefined;
    const t = this.now();
    if (existing) {
      if (input.name && input.name !== existing.name) {
        this.db
          .prepare("UPDATE chats SET name = ?, updated_at = ? WHERE id = ?")
          .run(input.name, t, String(existing.id));
      }
      if (input.parentId && input.parentId !== existing.parent_id) {
        this.db
          .prepare("UPDATE chats SET parent_id = ?, updated_at = ? WHERE id = ?")
          .run(input.parentId, t, String(existing.id));
      }
      if (input.peerId && !existing.peer_id) {
        this.db
          .prepare("UPDATE chats SET peer_id = ?, updated_at = ? WHERE id = ?")
          .run(input.peerId, t, String(existing.id));
      }
      return this.chat(String(existing.id)) as Chat;
    }
    const id = this.mint("chats", "c", 4);
    this.db
      .prepare(
        "INSERT INTO chats (id, connection_id, platform_id, kind, name, parent_id, peer_id, listen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.connectionId,
        input.platformId,
        input.kind,
        input.name ?? null,
        input.parentId ?? null,
        input.peerId ?? null,
        // A group hears everything by default (docs/spec.md 4.2); the owner can turn it off.
        input.kind === "group" ? 1 : 0,
        t,
        t,
      );
    return this.chat(id) as Chat;
  }

  /** The direct chat with this person on this bot, if there is one. */
  directChat(connectionId: string, peerId: string): Chat | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM chats WHERE connection_id = ? AND kind = 'dm' AND peer_id = ? ORDER BY created_at LIMIT 1",
      )
      .get(connectionId, peerId) as Row | undefined;
    return row && toChat(row);
  }

  /**
   * The platform named the chat once it existed: a direct chat opened by addressing the person gets
   * the chat's own ID, so their replies land in it. Kept as it was if another chat already has that ID.
   */
  renameChatPlatformId(id: string, platformId: string): void {
    try {
      this.db.prepare("UPDATE chats SET platform_id = ?, updated_at = ? WHERE id = ?").run(platformId, this.now(), id);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  chat(id: string): Chat | undefined {
    const row = this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as Row | undefined;
    return row && toChat(row);
  }

  /** The chat, if it belongs to one of this agent's connections. */
  agentChat(agentId: string, chatId: string): Chat | undefined {
    const row = this.db
      .prepare("SELECT c.* FROM chats c JOIN connections n ON n.id = c.connection_id WHERE c.id = ? AND n.agent_id = ?")
      .get(chatId, agentId) as Row | undefined;
    return row && toChat(row);
  }

  agentChats(agentId: string): (Chat & { platform: Platform; lastAt: number | null })[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, n.platform, (SELECT max(created_at) FROM messages m WHERE m.chat_id = c.id) AS last_at
         FROM chats c JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? ORDER BY last_at DESC NULLS LAST`,
      )
      .all(agentId) as Row[];
    return rows.map((r) => ({
      ...toChat(r),
      platform: String(r.platform) as Platform,
      lastAt: r.last_at === null ? null : Number(r.last_at),
    }));
  }

  // ---------------------------------------------------------------- contacts

  /**
   * The contact for this person on this bot, created on first sight. A non-empty platform name
   * that is not just the ID replaces the stored one; the alias is never touched here.
   */
  touchContact(connectionId: string, platformId: string, name: string | null | undefined): Contact {
    const reported = name?.trim() && name.trim() !== platformId ? name.trim() : null;
    const existing = this.contactByPlatformId(connectionId, platformId);
    const t = this.now();
    if (existing) {
      if (reported && reported !== existing.name) {
        this.db.prepare("UPDATE contacts SET name = ?, updated_at = ? WHERE id = ?").run(reported, t, existing.id);
        return { ...existing, name: reported, updatedAt: t };
      }
      return existing;
    }
    const id = this.mint("contacts", "u", 4);
    this.db
      .prepare(
        "INSERT INTO contacts (id, connection_id, platform_id, name, alias, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(id, connectionId, platformId, reported, t, t);
    return this.contact(id) as Contact;
  }

  contact(id: string): Contact | undefined {
    const row = this.db.prepare(`${CONTACTS} WHERE k.id = ?`).get(id) as Row | undefined;
    return row && toContact(row);
  }

  contactByPlatformId(connectionId: string, platformId: string): Contact | undefined {
    const row = this.db
      .prepare(`${CONTACTS} WHERE k.connection_id = ? AND k.platform_id = ?`)
      .get(connectionId, platformId) as Row | undefined;
    return row && toContact(row);
  }

  /** The contact, if it belongs to one of this agent's connections. */
  agentContact(agentId: string, id: string): Contact | undefined {
    const row = this.db
      .prepare(`${CONTACTS} JOIN connections n ON n.id = k.connection_id WHERE k.id = ? AND n.agent_id = ?`)
      .get(id, agentId) as Row | undefined;
    return row && toContact(row);
  }

  /** Everyone this agent knows, most recently changed first. */
  agentContacts(agentId: string): (Contact & { platform: Platform; owner: boolean })[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, p.name AS person_name, n.platform,
                (n.owner_id IS NOT NULL AND n.owner_id = k.platform_id) AS is_owner
         FROM contacts k JOIN connections n ON n.id = k.connection_id
         LEFT JOIN people p ON p.id = k.person_id
         WHERE n.agent_id = ? ORDER BY k.updated_at DESC`,
      )
      .all(agentId) as Row[];
    return rows.map((r) => ({ ...toContact(r), platform: String(r.platform) as Platform, owner: r.is_owner === 1 }));
  }

  /**
   * Whom the agent can @-mention in a chat: everyone on that bot, with whether they spoke in the
   * chat (or the group a thread belongs to), which settles two people with the same name.
   */
  mentionCandidates(chat: Chat): (Contact & { spoke: boolean })[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, p.name AS person_name,
                EXISTS (SELECT 1 FROM messages m
                        WHERE m.chat_id IN (?, ?) AND m.direction = 'in' AND m.sender_id = k.platform_id) AS spoke
         FROM contacts k LEFT JOIN people p ON p.id = k.person_id
         WHERE k.connection_id = ?`,
      )
      .all(chat.id, chat.parentId ?? chat.id, chat.connectionId) as Row[];
    return rows.map((r) => ({ ...toContact(r), spoke: r.spoke === 1 }));
  }

  /** This agent's contacts who have written to one of its bots: who the owner has seen talk to it. */
  contactsWhoWrote(agentId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT k.id FROM contacts k JOIN connections n ON n.id = k.connection_id
         WHERE n.agent_id = ? AND EXISTS (
           SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id
           WHERE c.connection_id = k.connection_id AND m.direction = 'in' AND m.sender_id = k.platform_id
         )`,
      )
      .all(agentId) as Row[];
    return new Set(rows.map((r) => String(r.id)));
  }

  setContactAccess(id: string, access: Access): void {
    this.db.prepare("UPDATE contacts SET access = ?, updated_at = ? WHERE id = ?").run(access, this.now(), id);
  }

  setChatAccess(id: string, access: Access): void {
    this.db.prepare("UPDATE chats SET access = ?, updated_at = ? WHERE id = ?").run(access, this.now(), id);
  }

  setChatListen(id: string, listen: boolean): void {
    this.db.prepare("UPDATE chats SET listen = ?, updated_at = ? WHERE id = ?").run(listen ? 1 : 0, this.now(), id);
  }

  setChatHearTier(id: string, tier: HearTier | null): void {
    this.db.prepare("UPDATE chats SET hear_tier = ?, updated_at = ? WHERE id = ?").run(tier, this.now(), id);
  }

  setChatAliases(id: string, aliases: readonly string[]): void {
    this.db
      .prepare("UPDATE chats SET aliases = ?, updated_at = ? WHERE id = ?")
      .run(aliases.length > 0 ? JSON.stringify(aliases) : null, this.now(), id);
  }

  setChatHearPace(id: string, pace: HearPace): void {
    this.db
      .prepare("UPDATE chats SET hear_pace = ?, hear_every_ms = ?, updated_at = ? WHERE id = ?")
      .run(pace.kind === "auto" ? null : pace.kind, pace.kind === "every" ? pace.ms : null, this.now(), id);
  }

  /**
   * The people and groups whose access is decided, for the owner to change their mind: everyone but
   * the bots' owners, who can always talk to the agent. Most recently changed first.
   */
  decidedAccess(agentId: string): {
    contacts: (Contact & { platform: Platform })[];
    groups: (Chat & { platform: Platform })[];
  } {
    const contacts = this.db
      .prepare(
        `SELECT k.*, n.platform FROM contacts k JOIN connections n ON n.id = k.connection_id
         WHERE n.agent_id = ? AND k.access IS NOT NULL AND (n.owner_id IS NULL OR n.owner_id <> k.platform_id)
         ORDER BY k.updated_at DESC`,
      )
      .all(agentId) as Row[];
    const groups = this.db
      .prepare(
        `SELECT c.*, n.platform FROM chats c JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND c.kind = 'group' AND c.access IS NOT NULL
         ORDER BY c.updated_at DESC`,
      )
      .all(agentId) as Row[];
    return {
      contacts: contacts.map((r) => ({ ...toContact(r), platform: String(r.platform) as Platform })),
      groups: groups.map((r) => ({ ...toChat(r), platform: String(r.platform) as Platform })),
    };
  }

  /** This agent's messages waiting for the owner to let their sender or group in, oldest first. */
  heldMessages(agentId: string): (Message & { chat: Chat; connectionId: string; platform: Platform })[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, n.platform, c.connection_id FROM messages m JOIN chats c ON c.id = m.chat_id
         JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.state = 'held' ORDER BY m.created_at, m.rowid`,
      )
      .all(agentId) as Row[];
    return rows.map((r) => {
      const message = toMessage(r);
      return {
        ...message,
        chat: this.chat(message.chatId) as Chat,
        connectionId: String(r.connection_id),
        platform: String(r.platform) as Platform,
      };
    });
  }

  /** The direct chat this bot has with this person, if they ever wrote to it there. */
  directChatWith(connectionId: string, platformUserId: string): Chat | undefined {
    const row = this.db
      .prepare(
        `SELECT c.* FROM chats c WHERE c.connection_id = ? AND c.kind = 'dm'
         AND EXISTS (SELECT 1 FROM messages m WHERE m.chat_id = c.id AND m.direction = 'in' AND m.sender_id = ?)
         ORDER BY c.updated_at DESC LIMIT 1`,
      )
      .get(connectionId, platformUserId) as Row | undefined;
    return row && toChat(row);
  }

  /** Mark a contact as a bot, or as a person again. */
  /** What the chat app says about where they sit; null when it no longer says. */
  setContactProfile(id: string, profile: string | null): void {
    this.db.prepare("UPDATE contacts SET profile = ? WHERE id = ?").run(profile, id);
  }

  setContactBot(id: string, isBot: boolean): Contact | undefined {
    this.db.prepare("UPDATE contacts SET is_bot = ?, updated_at = ? WHERE id = ?").run(isBot ? 1 : 0, this.now(), id);
    return this.contact(id);
  }

  /** Give a contact a name, or clear it with null to go back to the platform's. */
  setContactAlias(id: string, alias: string | null): Contact | undefined {
    this.db.prepare("UPDATE contacts SET alias = ?, updated_at = ? WHERE id = ?").run(alias, this.now(), id);
    return this.contact(id);
  }

  /**
   * Name whoever this contact is: the person when it has one (every account of theirs shows the
   * name), else the contact itself. Null clears it.
   */
  nameContact(id: string, name: string | null): Contact | undefined {
    const contact = this.contact(id);
    if (contact?.personId) this.updatePerson(contact.personId, { name });
    else this.setContactAlias(id, name);
    return this.contact(id);
  }

  // ------------------------------------------------------------------ people

  person(id: string): Person | undefined {
    const row = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id) as Row | undefined;
    return row && toPerson(row);
  }

  agentPerson(agentId: string, id: string): Person | undefined {
    const person = this.person(id);
    return person?.agentId === agentId ? person : undefined;
  }

  agentPeople(agentId: string): Person[] {
    const rows = this.db.prepare("SELECT * FROM people WHERE agent_id = ? ORDER BY id").all(agentId) as Row[];
    return rows.map(toPerson);
  }

  personContacts(personId: string): Contact[] {
    const rows = this.db.prepare(`${CONTACTS} WHERE k.person_id = ? ORDER BY k.created_at`).all(personId) as Row[];
    return rows.map(toContact);
  }

  updatePerson(id: string, patch: { name?: string | null; note?: string | null }): Person | undefined {
    const t = this.now();
    if (patch.name !== undefined)
      this.db.prepare("UPDATE people SET name = ?, updated_at = ? WHERE id = ?").run(patch.name, t, id);
    if (patch.note !== undefined)
      this.db.prepare("UPDATE people SET note = ?, updated_at = ? WHERE id = ?").run(patch.note, t, id);
    return this.person(id);
  }

  /** The contact's person, made for it alone when it has none (to hold a note). */
  ensurePerson(agentId: string, contactId: string): Person {
    const contact = this.contact(contactId);
    if (contact?.personId) return this.person(contact.personId) as Person;
    const id = this.mint("people", "p", 4);
    const t = this.now();
    // The name given to the contact moves up, so it still reads the same.
    this.db
      .prepare("INSERT INTO people (id, agent_id, name, note, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)")
      .run(id, agentId, contact?.alias ?? null, t, t);
    this.db
      .prepare("UPDATE contacts SET person_id = ?, linked_by = NULL, updated_at = ? WHERE id = ?")
      .run(id, t, contactId);
    return this.person(id) as Person;
  }

  /**
   * Put these contacts in one person, merging the people they were in (docs/spec.md 4.2). The
   * contacts named get `by` as how they were linked. Everyone moved over from another person by
   * the agent is the agent's link from now on: an agent cannot join two owner-made people into
   * one that would read as the owner's. The merged person keeps the first name and joins the notes.
   */
  linkContacts(agentId: string, ids: readonly string[], by: LinkedBy): Person {
    this.db.exec("BEGIN");
    try {
      const contacts = ids.map((id) => this.contact(id) as Contact);
      const first = contacts.find((k) => k.personId) ?? contacts[0];
      const target = this.ensurePerson(agentId, (first as Contact).id);
      let { name, note } = target;
      const t = this.now();
      for (const contact of contacts) {
        const current = this.contact(contact.id) as Contact;
        if (current.personId && current.personId !== target.id) {
          const other = this.person(current.personId) as Person;
          name = name ?? other.name;
          note = [note, other.note].filter(Boolean).join("\n\n") || null;
          this.db
            .prepare(
              `UPDATE contacts SET person_id = ?, updated_at = ?${by === "agent" ? ", linked_by = 'agent'" : ""} WHERE person_id = ?`,
            )
            .run(target.id, t, other.id);
          this.db.prepare("DELETE FROM people WHERE id = ?").run(other.id);
        } else if (!current.personId) {
          name = name ?? current.alias;
        }
        // The owner's word stands: the agent linking again does not turn an owner's link into its own.
        this.db
          .prepare(
            `UPDATE contacts SET person_id = ?, linked_by = ${by === "agent" ? "COALESCE(linked_by, 'agent')" : "'owner'"}, updated_at = ? WHERE id = ?`,
          )
          .run(target.id, t, contact.id);
      }
      this.db
        .prepare("UPDATE people SET name = ?, note = ?, updated_at = ? WHERE id = ?")
        .run(name, note, t, target.id);
      this.db.exec("COMMIT");
      return this.person(target.id) as Person;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Take a contact out of its person. A person left with no accounts goes; one left with a single
   * account keeps its name and note.
   */
  unlinkContact(id: string): void {
    const contact = this.contact(id);
    if (!contact?.personId) return;
    const t = this.now();
    this.db.prepare("UPDATE contacts SET person_id = NULL, linked_by = NULL, updated_at = ? WHERE id = ?").run(t, id);
    const left = this.personContacts(contact.personId);
    if (left.length === 0) this.db.prepare("DELETE FROM people WHERE id = ?").run(contact.personId);
    else if (left.length === 1) {
      this.db.prepare("UPDATE contacts SET linked_by = NULL WHERE id = ?").run((left[0] as Contact).id);
    }
  }

  /**
   * The chats where this contact can be found, most recent first: their direct chat with the bot
   * (by the messages they sent there), then groups they spoke in.
   */
  contactChats(contact: Contact, limit = 5): (Chat & { lastAt: number })[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, MAX(m.created_at) AS last_at FROM chats c JOIN messages m ON m.chat_id = c.id
         WHERE c.connection_id = ? AND m.direction = 'in' AND m.sender_id = ?
         GROUP BY c.id ORDER BY (c.kind = 'dm') DESC, last_at DESC LIMIT ?`,
      )
      .all(contact.connectionId, contact.platformId, limit) as Row[];
    return rows.map((r) => ({ ...toChat(r), lastAt: Number(r.last_at) }));
  }

  // ---------------------------------------------------------------- messages

  /** Store an inbound message. Returns undefined when the platform already delivered it. */
  insertInbound(input: {
    chatId: string;
    platformId: string;
    senderId: string;
    senderName: string;
    body: string;
    attachments: Omit<Attachment, "id">[];
    replyTo: string | null;
    triggers: boolean;
    /** A trigger from someone the owner has not let in yet: kept as `held` (docs/spec.md 4.7). */
    held?: boolean;
    createdAt: number;
  }): Message | undefined {
    const id = this.mint("messages", "m", 5);
    const attachments = input.attachments.map((a) => ({ ...a, id: this.mintFileId() }));
    const result = this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, attachments, reply_to, triggers, state, created_at)
         VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        id,
        input.chatId,
        input.platformId,
        input.senderId,
        input.senderName,
        input.body,
        attachments.length ? JSON.stringify(attachments) : null,
        input.replyTo,
        input.triggers ? 1 : 0,
        input.triggers ? (input.held ? "held" : "received") : "ignored",
        input.createdAt,
      );
    return result.changes ? this.message(id) : undefined;
  }

  private mintFileId(): string {
    for (let i = 0; i < 20; i++) {
      const id = shortId("f", 4);
      if (!this.db.prepare("SELECT 1 FROM messages WHERE attachments LIKE ?").get(`%"id":"${id}"%`)) return id;
    }
    return shortId("f", 7);
  }

  insertOutbound(input: {
    chatId: string;
    body: string;
    replyTo: string | null;
    notice?: boolean;
    lineTaskId?: string | null;
  }): Message {
    const id = this.mint("messages", "m", 5);
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, direction, body, reply_to, state, notice, line_task_id, created_at) VALUES (?, ?, 'out', ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, input.chatId, input.body, input.replyTo, input.notice ? 1 : 0, input.lineTaskId ?? null, this.now());
    return this.message(id) as Message;
  }

  /** The message went somewhere else than the chat it was sent to: the thread a reply opened under it. */
  setMessageChat(id: string, chatId: string): void {
    this.db.prepare("UPDATE messages SET chat_id = ? WHERE id = ?").run(chatId, id);
  }

  /** Hand an inbound message to a task's line (docs/spec.md 4.13). */
  setMessageLine(id: string, taskId: string): void {
    this.db.prepare("UPDATE messages SET line_task_id = ? WHERE id = ?").run(taskId, id);
  }

  setOutboundResult(id: string, state: OutboundState, platformId: string | null): void {
    try {
      this.db.prepare("UPDATE messages SET state = ?, platform_id = ? WHERE id = ?").run(state, platformId, id);
    } catch (error) {
      // A platform that reports the same message id twice hits the unique index; keep the
      // record with the outcome but without the colliding id.
      if (platformId === null || !isUniqueViolation(error)) throw error;
      this.db.prepare("UPDATE messages SET state = ?, platform_id = NULL WHERE id = ?").run(state, id);
    }
  }

  /**
   * The only way an inbound message changes state (src/core/inbound.ts). Each message moves
   * only if it is in one of the event's source states; the rest are left as they are, so a
   * late or repeated event cannot overwrite a newer state. Returns the IDs that moved.
   * `deliver` records `inputId`; `retry` clears the nudge so the message is nudged again.
   */
  moveInbound(ids: readonly string[], event: InboundEvent, inputId?: string, retryAt?: number): string[] {
    const rule = INBOUND[event];
    // `hold` sets when to try again and counts the wait; leaving `waiting` clears the time; the
    // owner's retry starts the count over.
    const stmt = this.db.prepare(
      `UPDATE messages SET state = ?, input_id = coalesce(?, input_id),
         nudged = CASE WHEN ? THEN 0 ELSE nudged END,
         retry_at = CASE WHEN ? THEN ? ELSE NULL END,
         holds = CASE WHEN ? THEN holds + 1 WHEN ? THEN 0 ELSE holds END
       WHERE id = ? AND direction = 'in' AND state IN (${rule.from.map(() => "?").join(", ")})`,
    );
    const hold = event === "hold" ? 1 : 0;
    // `retry` and `resume` both put the message back as received, so both earn a fresh nudge.
    const renudge = event === "retry" || event === "resume" ? 1 : 0;
    const moved: string[] = [];
    for (const id of ids) {
      const result = stmt.run(
        rule.to,
        inputId ?? null,
        renudge,
        hold,
        retryAt ?? null,
        hold,
        event === "retry" ? 1 : 0,
        id,
        ...rule.from,
      );
      if (result.changes) moved.push(id);
    }
    return moved;
  }

  message(id: string): Message | undefined {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return row && toMessage(row);
  }

  /** The message, if it is in one of this agent's chats. */
  agentMessage(agentId: string, id: string): (Message & { chat: Chat }) | undefined {
    const row = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE m.id = ? AND n.agent_id = ?`,
      )
      .get(id, agentId) as Row | undefined;
    if (!row) return undefined;
    const message = toMessage(row);
    return { ...message, chat: this.chat(message.chatId) as Chat };
  }

  /** Whether `id` names a message in this chat. */
  hasMessage(chatId: string, id: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM messages WHERE id = ? AND chat_id = ?").get(id, chatId));
  }

  messageByPlatformId(chatId: string, platformId: string): Message | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? AND platform_id = ?")
      .get(chatId, platformId) as Row | undefined;
    return row && toMessage(row);
  }

  chatMessages(chatId: string, limit: number, before?: string): Message[] {
    // Before the anchor in the order stored: one stored in the same millisecond still came first.
    const anchor = before
      ? (this.db.prepare("SELECT created_at, rowid FROM messages WHERE id = ?").get(before) as
          | { created_at: number; rowid: number }
          | undefined)
      : undefined;
    const at = anchor ? Number(anchor.created_at) : Number.MAX_SAFE_INTEGER;
    const row = anchor ? Number(anchor.rowid) : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?)) ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(chatId, at, at, row, limit) as Row[];
    return rows.map(toMessage).reverse();
  }

  /**
   * Messages around `messageId` in its chat, oldest first: about half of `limit` before it,
   * the message itself, and the rest after. Undefined when the message is not in this chat.
   */
  chatAround(chatId: string, messageId: string, limit: number): Message[] | undefined {
    const anchor = this.anchor(chatId, messageId);
    if (!anchor) return undefined;
    const older = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND (created_at < ? OR (created_at = ? AND rowid < ?))
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(chatId, anchor.at, anchor.at, anchor.rowid, Math.floor((limit - 1) / 2)) as Row[];
    const newer = this.after(chatId, anchor, limit - 1 - older.length);
    return [...older.map(toMessage).reverse(), anchor.message, ...newer];
  }

  /**
   * The first `limit` messages after `messageId` in its chat, oldest first, without the message
   * itself. Undefined when the message is not in this chat.
   */
  chatSince(chatId: string, messageId: string, limit: number): Message[] | undefined {
    const anchor = this.anchor(chatId, messageId);
    return anchor && this.after(chatId, anchor, limit);
  }

  private anchor(chatId: string, messageId: string): { message: Message; at: number; rowid: number } | undefined {
    const row = this.db.prepare("SELECT rowid, * FROM messages WHERE id = ? AND chat_id = ?").get(messageId, chatId) as
      | Row
      | undefined;
    return row && { message: toMessage(row), at: Number(row.created_at), rowid: Number(row.rowid) };
  }

  private after(chatId: string, anchor: { at: number; rowid: number }, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?))
         ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(chatId, anchor.at, anchor.at, anchor.rowid, limit) as Row[];
    return rows.map(toMessage);
  }

  /** When the agent first spoke in this chat itself at or after `at` (notices do not count), if it has. */
  firstSpokeAt(chatId: string, at: number): number | undefined {
    const row = this.db
      .prepare(
        `SELECT min(created_at) AS at FROM messages WHERE chat_id = ? AND direction = 'out' AND notice = 0
         AND state IN ('sent', 'uncertain') AND created_at >= ?`,
      )
      .get(chatId, at) as Row;
    return row.at == null ? undefined : Number(row.at);
  }

  /** When the agent last spoke in this chat itself (Mingle's own notices do not count), if it has. */
  lastSpokeAt(chatId: string): number | undefined {
    const row = this.db
      .prepare(
        `SELECT max(created_at) AS at FROM messages WHERE chat_id = ? AND direction = 'out' AND notice = 0
         AND state IN ('sent', 'uncertain')`,
      )
      .get(chatId) as Row;
    return row.at == null ? undefined : Number(row.at);
  }

  /**
   * The latest messages in this chat that did not reach the agent, from `from` on, oldest first, at
   * most `limit` (docs/spec.md 4.2, a group that hears everything).
   */
  background(chatId: string, from: number, limit: number): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages WHERE chat_id = ? AND direction = 'in' AND triggers = 0 AND created_at >= ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?`,
      )
      .all(chatId, from, limit) as Row[];
    return rows.map(toMessage).reverse();
  }

  /**
   * Like `background`, but the messages of `first` (the people in a conversation with the agent) come
   * before the rest: theirs fill the limit first, the newest of the others the room left. Oldest first.
   */
  backgroundFor(chatId: string, from: number, first: ReadonlySet<string>, limit: number): Message[] {
    if (first.size === 0) return this.background(chatId, from, limit);
    const all = this.background(chatId, from, Number.MAX_SAFE_INTEGER);
    if (all.length <= limit) return all;
    const theirs = all.filter((m) => m.senderId !== null && first.has(m.senderId)).slice(-limit);
    const keep = new Set(theirs);
    const others = all.filter((m) => !keep.has(m));
    for (const m of others.slice(Math.max(0, others.length - (limit - theirs.length)))) keep.add(m);
    return all.filter((m) => keep.has(m));
  }

  /**
   * What the agent said in this chat after `after` (Mingle's notices do not count), oldest first, and
   * who sent the message each one quotes (docs/spec.md 4.2: whom it answered).
   */
  spokenSince(chatId: string, after: number): { createdAt: number; quotedSender: string | null }[] {
    const rows = this.db
      .prepare(
        `SELECT m.created_at AS at, q.sender_id AS quoted FROM messages m LEFT JOIN messages q ON q.id = m.reply_to
         WHERE m.chat_id = ? AND m.direction = 'out' AND m.notice = 0 AND m.state IN ('sent', 'uncertain')
         AND m.created_at > ? ORDER BY m.created_at, m.rowid`,
      )
      .all(chatId, after) as Row[];
    return rows.map((r) => ({ createdAt: Number(r.at), quotedSender: str(r.quoted) }));
  }

  /** The people (not bots) who spoke in a group or its threads since `since` (docs/spec.md 4.2). */
  activePeople(groupId: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT count(DISTINCT m.sender_id) AS n FROM messages m JOIN chats c ON c.id = m.chat_id
         LEFT JOIN contacts k ON k.connection_id = c.connection_id AND k.platform_id = m.sender_id
         WHERE (c.id = ? OR c.parent_id = ?) AND m.direction = 'in' AND m.sender_id IS NOT NULL
         AND m.created_at >= ? AND coalesce(k.is_bot, 0) = 0`,
      )
      .get(groupId, groupId, since) as Row;
    return Number(row.n);
  }

  /** How many messages `background(chatId, from, …)` could return without a limit. */
  backgroundCount(chatId: string, from: number): number {
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM messages WHERE chat_id = ? AND direction = 'in' AND triggers = 0 AND created_at >= ?`,
      )
      .get(chatId, from) as Row;
    return Number(row.n);
  }

  /**
   * How many messages in this chat, and in the chat its thread belongs to, did not reach the
   * agent since it last spoke there (docs/spec.md 4.2). "There" is the whole channel: the chat,
   * its parent and the parent's other threads. Messages from before `before` only.
   */
  unseen(chatId: string, before: number): number {
    const chat = this.chat(chatId);
    if (!chat) return 0;
    const scope = chat.parentId ? [chat.id, chat.parentId] : [chat.id];
    const marks = scope.map(() => "?").join(", ");
    const spoke = this.db
      .prepare(
        `SELECT max(created_at) AS at FROM messages WHERE direction = 'out' AND notice = 0 AND state IN ('sent', 'uncertain')
         AND created_at <= ? AND chat_id IN (SELECT id FROM chats WHERE id IN (${marks}) OR parent_id IN (${marks}))`,
      )
      .get(before, ...scope, ...scope) as Row;
    const row = this.db
      .prepare(
        `SELECT count(*) AS n FROM messages WHERE chat_id IN (${marks}) AND direction = 'in' AND triggers = 0
         AND created_at > ? AND created_at < ?`,
      )
      .get(...scope, spoke.at == null ? -1 : Number(spoke.at), before) as Row;
    return Number(row.n);
  }

  /**
   * Messages containing every word of `query` (a "quoted phrase" counts as one), newest first.
   * Words of three characters or more use the trigram index; shorter ones (two Chinese
   * characters, say) fall back to LIKE.
   */
  search(agentId: string, query: string, chatId?: string, limit = 20): Message[] {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const long = terms.filter((t) => [...t].length >= 3);
    const short = terms.filter((t) => [...t].length < 3);
    const scope = chatId ? "AND m.chat_id = ?" : "";
    const scopeArgs = chatId ? [chatId] : [];
    const likes = short.map(() => "AND m.body LIKE ? ESCAPE '\\'").join(" ");
    const likeArgs = short.map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const sql = long.length
      ? `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE messages_fts MATCH ? AND n.agent_id = ? ${likes} ${scope} ORDER BY m.created_at DESC LIMIT ?`
      : `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? ${likes} ${scope} ORDER BY m.created_at DESC LIMIT ?`;
    const match = long.map((t) => `"${t.replaceAll('"', '""')}"`).join(" AND ");
    const args = long.length
      ? [match, agentId, ...likeArgs, ...scopeArgs, limit]
      : [agentId, ...likeArgs, ...scopeArgs, limit];
    return (this.db.prepare(sql).all(...args) as Row[]).map(toMessage);
  }

  /** Recent messages across all of an agent's chats, newest first, for the console. */
  agentActivity(agentId: string, limit: number): (Message & { chat: Chat; platform: Platform })[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, n.platform FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all(agentId, limit) as Row[];
    return rows.map((r) => {
      const message = toMessage(r);
      return { ...message, chat: this.chat(message.chatId) as Chat, platform: String(r.platform) as Platform };
    });
  }

  /**
   * The agent's chats that spoke most recently, newest first, each with its latest messages
   * (oldest first) for the console. Messages that still need the owner (unanswered, failed,
   * waiting, held) come along however old, so a busy chat cannot hide them. `before` pages one
   * chat further back.
   */
  agentConversations(
    agentId: string,
    opts: { chats: number; messages: number; chatId?: string; before?: number },
  ): {
    chat: Chat;
    parent: Chat | null;
    platform: Platform;
    latestAt: number;
    /** How many older messages are not shown; `cursor` as `before` reads them. */
    earlier: number;
    cursor: number | null;
    messages: Message[];
  }[] {
    const scope = opts.chatId ? "AND c.id = ?" : "";
    const heads = this.db
      .prepare(
        `SELECT c.id, n.platform, max(m.created_at) AS latest FROM messages m JOIN chats c ON c.id = m.chat_id
         JOIN connections n ON n.id = c.connection_id WHERE n.agent_id = ? ${scope}
         GROUP BY c.id ORDER BY latest DESC, max(m.rowid) DESC LIMIT ?`,
      )
      .all(agentId, ...(opts.chatId ? [opts.chatId] : []), opts.chats) as Row[];
    const before = opts.before ?? Number.MAX_SAFE_INTEGER;
    return heads.map((h) => {
      const chat = this.chat(String(h.id)) as Chat;
      const latest = (
        this.db
          .prepare(
            `SELECT * FROM messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
          )
          .all(chat.id, before, opts.messages) as Row[]
      ).map(toMessage);
      const oldest = latest.at(-1);
      const pending = oldest
        ? (
            this.db
              .prepare(
                `SELECT * FROM messages WHERE chat_id = ? AND direction = 'in' AND created_at < ?
                 AND state IN ('unanswered', 'failed', 'waiting', 'held')`,
              )
              .all(chat.id, oldest.createdAt) as Row[]
          ).map(toMessage)
        : [];
      const shown = [...latest, ...pending].sort((a, b) => a.createdAt - b.createdAt);
      const total = Number(
        (
          this.db
            .prepare("SELECT count(*) AS n FROM messages WHERE chat_id = ? AND created_at < ?")
            .get(chat.id, before) as Row
        ).n,
      );
      return {
        chat,
        parent: chat.parentId ? (this.chat(chat.parentId) ?? null) : null,
        platform: String(h.platform) as Platform,
        latestAt: Number(h.latest),
        earlier: total - shown.length,
        cursor: oldest?.createdAt ?? null,
        messages: shown,
      };
    });
  }

  /**
   * The agent's latest conversation across all its chats, oldest first. Ignored inbound messages
   * (background chatter, paused work, or requests the owner dismissed), messages still waiting for the
   * owner to let their sender in (docs/spec.md 4.7) and failed sends are left out.
   */
  recentConversation(agentId: string, limit: number, exclude: readonly string[] = []): Message[] {
    const marks = exclude.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND ((m.direction = 'in' AND m.triggers = 1 AND m.state NOT IN ('ignored', 'held')) OR (m.direction = 'out' AND m.notice = 0 AND m.state IN ('sent', 'uncertain')))
         ${exclude.length ? `AND m.id NOT IN (${marks})` : ""}
         ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all(agentId, ...exclude, limit) as Row[];
    return rows.map(toMessage).reverse();
  }

  /** Delivered inbound messages for this agent that nobody has answered yet. */
  awaitingReply(agentId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.direction = 'in' AND m.state = 'delivered' AND m.line_task_id IS NULL
         ORDER BY m.created_at`,
      )
      .all(agentId) as Row[];
    return rows.map(toMessage);
  }

  /** Follow-ups handed to a line and not answered yet (docs/spec.md 4.13), oldest first. */
  lineInbox(taskId: string): Message[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE line_task_id = ? AND direction = 'in' AND state = 'delivered' ORDER BY created_at",
      )
      .all(taskId) as Row[];
    return rows.map(toMessage);
  }

  /** Whether the agent sent anything into this chat after `at`: a reply to another message, or a plain send. */
  spokeSince(chatId: string, at: number): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM messages WHERE chat_id = ? AND direction = 'out' AND notice = 0 AND state = 'sent' AND created_at >= ? LIMIT 1",
      )
      .get(chatId, at);
    return row !== undefined;
  }

  markNudged(ids: readonly string[]): void {
    const stmt = this.db.prepare("UPDATE messages SET nudged = 1 WHERE id = ?");
    for (const id of ids) stmt.run(id);
  }

  wasNudged(id: string): boolean {
    const row = this.db.prepare("SELECT nudged FROM messages WHERE id = ?").get(id) as Row | undefined;
    return row?.nudged === 1;
  }

  /** Inbound messages of this agent the owner can retry or ignore (waiting, failed or unanswered), oldest first; `ids` narrows it. */
  retryable(agentId: string, ids?: readonly string[]): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.direction = 'in' AND m.state IN ('waiting', 'failed', 'unanswered') ORDER BY m.created_at`,
      )
      .all(agentId) as Row[];
    const wanted = ids && new Set(ids);
    return rows.map(toMessage).filter((m) => !wanted || wanted.has(m.id));
  }

  /** How many times this message has waited for a passing failure since the owner last retried it. */
  holds(id: string): number {
    const row = this.db.prepare("SELECT holds FROM messages WHERE id = ?").get(id) as Row | undefined;
    return Number(row?.holds ?? 0);
  }

  /** Waiting inbound messages whose retry time has come, oldest first, with their agent. */
  dueWaiting(now: number): (Message & { agentId: string })[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, n.agent_id AS owner_agent FROM messages m JOIN chats c ON c.id = m.chat_id
         JOIN connections n ON n.id = c.connection_id
         WHERE m.direction = 'in' AND m.state = 'waiting' AND m.retry_at <= ? ORDER BY m.created_at`,
      )
      .all(now) as Row[];
    return rows.map((r) => ({ ...toMessage(r), agentId: String(r.owner_agent) }));
  }

  /** This agent's waiting inbound messages. */
  waiting(agentId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.direction = 'in' AND m.state = 'waiting' ORDER BY m.created_at`,
      )
      .all(agentId) as Row[];
    return rows.map(toMessage);
  }

  /** When this agent last got a message that woke it, and last sent one; null when never. */
  lastMessageTimes(agentId: string): { inAt: number | null; outAt: number | null } {
    const row = this.db
      .prepare(
        `SELECT max(CASE WHEN m.direction = 'in' AND m.triggers = 1 THEN m.created_at END) AS in_at,
                max(CASE WHEN m.direction = 'out' AND m.notice = 0 AND m.state = 'sent' THEN m.created_at END) AS out_at
         FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ?`,
      )
      .get(agentId) as Row;
    return {
      inAt: row.in_at == null ? null : Number(row.in_at),
      outAt: row.out_at == null ? null : Number(row.out_at),
    };
  }

  /** How many of this agent's inbound messages since `since` are in each state, for diagnostics. */
  inboundCounts(agentId: string, since: number): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT m.state, count(*) AS n FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.direction = 'in' AND m.triggers = 1 AND m.created_at >= ? GROUP BY m.state`,
      )
      .all(agentId, since) as Row[];
    return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
  }

  /** Inbound messages received but never handed to the agent (for example, the process stopped first). */
  undelivered(agentId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.direction = 'in' AND m.state = 'received' ORDER BY m.created_at`,
      )
      .all(agentId) as Row[];
    return rows.map(toMessage);
  }

  attachment(agentId: string, fileId: string): { message: Message; chat: Chat; attachment: Attachment } | undefined {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.attachments LIKE ?`,
      )
      .all(agentId, `%"id":"${fileId}"%`) as Row[];
    for (const row of rows) {
      const message = toMessage(row);
      const attachment = message.attachments.find((a) => a.id === fileId);
      if (attachment) return { message, chat: this.chat(message.chatId) as Chat, attachment };
    }
    return undefined;
  }

  // ------------------------------------------------------------------- tasks

  createTask(input: { agentId: string; title: string; fromMessage: string | null; fromChat: string | null }): Task {
    const id = this.mint("tasks", "t", 3);
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO tasks (id, agent_id, title, from_message, from_chat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.agentId, input.title, input.fromMessage, input.fromChat, t, t);
    return this.task(input.agentId, id) as Task;
  }

  task(agentId: string, id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ? AND agent_id = ?").get(id, agentId) as
      | Row
      | undefined;
    return row && toTask(row);
  }

  tasks(agentId: string, all: boolean): Task[] {
    const filter = all ? "" : "AND status IN ('todo', 'in_progress')";
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE agent_id = ? ${filter} ORDER BY created_at`)
      .all(agentId) as Row[];
    return rows.map(toTask);
  }

  /** A task with a line of its own, started at once or queued (docs/spec.md 4.13). */
  createLineTask(input: {
    agentId: string;
    title: string;
    fromMessage: string;
    fromChat: string;
    brief: string;
    /** The thread the work happens in from the start: the message was already in one. */
    threadChat?: string | null;
  }): Task {
    const id = this.mint("tasks", "t", 3);
    const t = this.now();
    this.db
      .prepare(
        "INSERT INTO tasks (id, agent_id, title, status, from_message, from_chat, line_state, brief, thread_chat, created_at, updated_at) VALUES (?, ?, ?, 'in_progress', ?, ?, 'queued', ?, ?, ?, ?)",
      )
      .run(
        id,
        input.agentId,
        input.title,
        input.fromMessage,
        input.fromChat,
        input.brief,
        input.threadChat ?? null,
        t,
        t,
      );
    return this.task(input.agentId, id) as Task;
  }

  /** A task by its ID alone, for the line that works on it. */
  taskById(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return row && toTask(row);
  }

  updateLine(
    id: string,
    patch: Partial<{
      lineState: LineState;
      sessionId: string | null;
      summary: string;
      lineError: string | null;
      threadChat: string;
      progress: string;
    }>,
  ): void {
    const columns: Record<string, string> = {
      lineState: "line_state",
      sessionId: "session_id",
      summary: "summary",
      lineError: "line_error",
      threadChat: "thread_chat",
      progress: "progress",
    };
    const sets: string[] = [];
    const values: (string | null)[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...values, this.now(), id);
  }

  /**
   * The agent's tasks that have a line: those still under way, and those finished in the last day,
   * for the console's "what it is doing" (docs/spec.md 4.13). Oldest first.
   */
  lineTasks(agentId: string, since: number): Task[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM tasks WHERE agent_id = ? AND line_state IS NOT NULL
           AND (line_state IN ('queued', 'running') OR status IN ('todo', 'in_progress') OR updated_at >= ?)
           ORDER BY created_at`,
        )
        .all(agentId, since) as Row[]
    ).map(toTask);
  }

  /** Every task whose line has work under way or waiting for a free line, for restarts. */
  activeLines(agentId?: string): Task[] {
    const scope = agentId ? "AND agent_id = ?" : "";
    return (
      this.db
        .prepare(`SELECT * FROM tasks WHERE line_state IN ('queued', 'running') ${scope} ORDER BY created_at`)
        .all(...(agentId ? [agentId] : [])) as Row[]
    ).map(toTask);
  }

  /** The line a follow-up belongs to: the task whose line sent `messageId`, or that it was started from. */
  lineOfMessage(agentId: string, messageId: string): Task | undefined {
    const row = this.db
      .prepare(
        `SELECT t.* FROM tasks t WHERE t.agent_id = ? AND t.line_state IS NOT NULL AND (
           t.id = (SELECT line_task_id FROM messages WHERE id = ?) OR t.from_message = ?)
         ORDER BY t.created_at DESC LIMIT 1`,
      )
      .get(agentId, messageId, messageId) as Row | undefined;
    return row && toTask(row);
  }

  /**
   * A line still on the work for `messageId`: queued, running or waiting for more. Not one that was
   * stopped, closed or stopped with an error (that one is started again with a new line).
   */
  lineFromMessage(agentId: string, messageId: string): Task | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM tasks WHERE agent_id = ? AND from_message = ? AND line_state IN ('queued', 'running', 'idle')
           AND status != 'closed' ORDER BY created_at DESC LIMIT 1`,
      )
      .get(agentId, messageId) as Row | undefined;
    return row && toTask(row);
  }

  /** The latest line whose thread this chat is, or that was started in it (docs/spec.md 4.13). */
  lineOfChat(agentId: string, chatId: string): Task | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM tasks WHERE agent_id = ? AND line_state IS NOT NULL AND (thread_chat = ? OR from_chat = ?) ORDER BY created_at DESC LIMIT 1",
      )
      .get(agentId, chatId, chatId) as Row | undefined;
    return row && toTask(row);
  }

  /** The line still working for this message that has no thread yet, so a reply to it can open one. */
  threadlessLine(agentId: string, messageId: string): Task | undefined {
    const task = this.lineFromMessage(agentId, messageId);
    return task && !task.threadChat ? task : undefined;
  }

  setTaskStatus(agentId: string, id: string, status: TaskStatus): Task | undefined {
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND agent_id = ?")
      .run(status, this.now(), id, agentId);
    return this.task(agentId, id);
  }

  // --------------------------------------------------------------- reminders

  createReminder(
    input: Omit<Reminder, "id" | "createdAt" | "lastFiredAt" | "sourceMessageId" | "check"> & {
      sourceMessageId?: string | null;
      /** A reminder that fires on change, with the hash of its first run as the baseline. */
      check?: { command: string; once: boolean; hash: string; until: number | null } | null;
    },
  ): Reminder {
    const id = this.mint("reminders", "r", 3);
    const check = input.check ?? null;
    this.db
      .prepare(
        `INSERT INTO reminders (id, agent_id, body, rule, timezone, chat_id, source_message_id, next_fire_at, created_at,
           check_command, check_once, check_hash, last_checked_at, check_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.body,
        input.rule,
        input.timezone,
        input.chatId,
        input.sourceMessageId ?? null,
        input.nextFireAt,
        this.now(),
        check?.command ?? null,
        check?.once ? 1 : 0,
        check?.hash ?? null,
        check ? this.now() : null,
        check?.until ?? null,
      );
    return this.reminder(input.agentId, id) as Reminder;
  }

  /** One of the agent's reminders, including a one-off that has already fired. */
  reminder(agentId: string, id: string): Reminder | undefined {
    const row = this.db.prepare("SELECT * FROM reminders WHERE id = ? AND agent_id = ?").get(id, agentId) as
      | Row
      | undefined;
    return row && toReminder(row);
  }

  reminders(agentId: string): Reminder[] {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE agent_id = ? AND next_fire_at IS NOT NULL ORDER BY next_fire_at")
      .all(agentId) as Row[];
    return rows.map(toReminder);
  }

  /**
   * Reminders that are due, except a paused agent's: they wait and fire once it resumes. A check
   * whose time ran out is due at its deadline even when its next poll is later, so it ends on time.
   */
  dueReminders(at: number): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM reminders r JOIN agents a ON a.id = r.agent_id
         WHERE r.next_fire_at IS NOT NULL
           AND (r.next_fire_at <= ? OR (r.check_command IS NOT NULL AND r.check_until IS NOT NULL AND r.check_until <= ?))
           AND a.status != 'paused' ORDER BY r.next_fire_at`,
      )
      .all(at, at) as Row[];
    return rows.map(toReminder);
  }

  /** A reminder fired at `at`; `next` is when it fires again, null for a one-off. */
  markReminderFired(id: string, at: number, next: number | null): void {
    this.db.prepare("UPDATE reminders SET next_fire_at = ?, last_fired_at = ? WHERE id = ?").run(next, at, id);
  }

  /** A check came due: it runs now and comes due again at `next`. Not a fire: the agent heard nothing. */
  markReminderDue(id: string, next: number | null): void {
    this.db.prepare("UPDATE reminders SET next_fire_at = ? WHERE id = ?").run(next, id);
  }

  /**
   * A check ran and worked. When its output changed, the new hash becomes the baseline and the
   * reminder fired at `at`; a `once` check then ends. The output itself is never stored.
   */
  recordCheck(id: string, at: number, result: { hash: string; fired: boolean; ended: boolean }): void {
    if (result.fired) {
      this.db
        .prepare(
          `UPDATE reminders SET check_hash = ?, check_failures = 0, check_error = NULL,
             last_checked_at = ?, last_fired_at = ?, next_fire_at = CASE WHEN ? THEN NULL ELSE next_fire_at END
           WHERE id = ?`,
        )
        .run(result.hash, at, at, result.ended ? 1 : 0, id);
    } else {
      this.db
        .prepare("UPDATE reminders SET check_failures = 0, check_error = NULL, last_checked_at = ? WHERE id = ?")
        .run(at, id);
    }
  }

  /** A check failed; returns how many times in a row it has now. */
  recordCheckFailure(id: string, at: number, error: string): number {
    this.db
      .prepare(
        "UPDATE reminders SET check_failures = check_failures + 1, check_error = ?, last_checked_at = ? WHERE id = ?",
      )
      .run(error, at, id);
    const row = this.db.prepare("SELECT check_failures FROM reminders WHERE id = ?").get(id) as Row | undefined;
    return row ? Number(row.check_failures) : 0;
  }

  /** Move the next fire. A recurring reminder goes back to its rule after that one. */
  setReminderNext(agentId: string, id: string, next: number): Reminder | undefined {
    const changed = this.db
      .prepare("UPDATE reminders SET next_fire_at = ? WHERE id = ? AND agent_id = ?")
      .run(next, id, agentId).changes;
    return changed ? this.reminder(agentId, id) : undefined;
  }

  deleteReminder(agentId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM reminders WHERE id = ? AND agent_id = ?").run(id, agentId).changes > 0;
  }

  // ------------------------------------------------------------- owner notes

  /** Something the owner changed for the agent, told with its next input (docs/spec.md 4.6). */
  addOwnerNote(agentId: string, body: string): void {
    this.db
      .prepare("INSERT INTO owner_notes (agent_id, body, created_at) VALUES (?, ?, ?)")
      .run(agentId, body, this.now());
  }

  /** The notes not yet told, oldest first. */
  ownerNotes(agentId: string): { id: number; body: string }[] {
    const rows = this.db
      .prepare("SELECT id, body FROM owner_notes WHERE agent_id = ? ORDER BY id")
      .all(agentId) as Row[];
    return rows.map((r) => ({ id: Number(r.id), body: String(r.body) }));
  }

  // ---------------------------------------------------------------- handoffs

  addHandoff(agentId: string, body: string, via: Handoff["via"]): Handoff {
    const id = this.mint("handoffs", "h", 4);
    this.db
      .prepare("INSERT INTO handoffs (id, agent_id, body, via, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, agentId, body, via, this.now());
    return this.handoff(id) as Handoff;
  }

  handoff(id: string): Handoff | undefined {
    const row = this.db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row | undefined;
    return row && toHandoff(row);
  }

  /** Newest first. */
  handoffs(agentId: string, limit: number): Handoff[] {
    const rows = this.db
      .prepare("SELECT * FROM handoffs WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(agentId, limit) as Row[];
    return rows.map(toHandoff);
  }

  /** Not yet delivered, oldest first. */
  waitingHandoffs(agentId: string): Handoff[] {
    const rows = this.db
      .prepare("SELECT * FROM handoffs WHERE agent_id = ? AND state = 'waiting' ORDER BY created_at, rowid")
      .all(agentId) as Row[];
    return rows.map(toHandoff);
  }

  /** The agent's session accepted them. */
  markHandoffsDelivered(ids: readonly string[]): void {
    const mark = this.db.prepare(
      "UPDATE handoffs SET state = 'delivered', delivered_at = ? WHERE id = ? AND state = 'waiting'",
    );
    const t = this.now();
    for (const id of ids) mark.run(t, id);
  }

  /** The agent was told these. */
  deleteOwnerNotes(agentId: string, ids: readonly number[]): void {
    const remove = this.db.prepare("DELETE FROM owner_notes WHERE id = ? AND agent_id = ?");
    for (const id of ids) remove.run(id, agentId);
  }
}

const str = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : String(v));

function toAgent(r: Row): Agent {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    avatar: str(r.avatar),
    harness: String(r.harness),
    model: str(r.model),
    sessionId: str(r.session_id),
    status: String(r.status) as AgentStatus,
    statusDetail: str(r.status_detail),
    statusFailure: str(r.status_failure),
    hasReplied: Number(r.has_replied) === 1,
    askAll: Number(r.ask_all) === 1,
    tidy: Number(r.tidy) === 1,
    createdAt: Number(r.created_at),
  };
}

function toHandoff(r: Row): Handoff {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    body: String(r.body),
    via: String(r.via) as Handoff["via"],
    state: String(r.state) as Handoff["state"],
    createdAt: Number(r.created_at),
    deliveredAt: r.delivered_at == null ? null : Number(r.delivered_at),
  };
}

function toConnection(r: Row): Connection {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    platform: String(r.platform) as Platform,
    botId: str(r.bot_id),
    botName: str(r.bot_name),
    state: String(r.state) as ConnectionStateKind,
    stateDetail: str(r.state_detail),
    secretRef: str(r.secret_ref),
    ownerId: str(r.owner_id),
    claimCode: str(r.claim_code),
    claimExpiresAt: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
  };
}

function toContact(r: Row): Contact {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    platformId: String(r.platform_id),
    name: str(r.name),
    alias: str(r.alias),
    access: access(r.access),
    isBot: r.is_bot === 1,
    personId: str(r.person_id),
    personName: str(r.person_name),
    linkedBy: (str(r.linked_by) as LinkedBy | null) ?? null,
    profile: str(r.profile),
    updatedAt: Number(r.updated_at),
  };
}

function toPerson(r: Row): Person {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    name: str(r.name),
    note: str(r.note),
    updatedAt: Number(r.updated_at),
  };
}

function hearPace(r: Row): HearPace {
  if (r.hear_pace === "muted") return { kind: "muted" };
  if (r.hear_pace === "every" && Number(r.hear_every_ms) > 0) return { kind: "every", ms: Number(r.hear_every_ms) };
  return { kind: "auto" };
}

function aliases(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}

function toChat(r: Row): Chat {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    platformId: String(r.platform_id),
    kind: String(r.kind) as ChatKind,
    name: str(r.name),
    parentId: str(r.parent_id),
    access: access(r.access),
    listen: Number(r.listen ?? 0) === 1,
    hearPace: hearPace(r),
    hearTier: r.hear_tier === "save" || r.hear_tier === "balanced" || r.hear_tier === "fast" ? r.hear_tier : null,
    aliases: aliases(r.aliases),
    peerId: str(r.peer_id),
  };
}

function toMessage(r: Row): Message {
  return {
    id: String(r.id),
    chatId: String(r.chat_id),
    direction: String(r.direction) as "in" | "out",
    platformId: str(r.platform_id),
    senderId: str(r.sender_id),
    senderName: str(r.sender_name),
    body: String(r.body),
    attachments: r.attachments ? (JSON.parse(String(r.attachments)) as Attachment[]) : [],
    replyTo: str(r.reply_to),
    triggers: r.triggers === 1,
    state: String(r.state) as Message["state"],
    createdAt: Number(r.created_at),
    retryAt: r.retry_at == null ? null : Number(r.retry_at),
    ...(r.notice === 1 ? { notice: true } : {}),
    ...(r.line_task_id ? { lineTaskId: String(r.line_task_id) } : {}),
  };
}

function toTask(r: Row): Task {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    title: String(r.title),
    status: String(r.status) as TaskStatus,
    fromMessage: str(r.from_message),
    fromChat: str(r.from_chat),
    lineState: (str(r.line_state) as LineState | null) ?? null,
    sessionId: str(r.session_id),
    brief: str(r.brief),
    summary: str(r.summary),
    lineError: str(r.line_error),
    threadChat: str(r.thread_chat),
    progress: str(r.progress),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function toReminder(r: Row): Reminder {
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    body: String(r.body),
    rule: String(r.rule),
    timezone: String(r.timezone),
    chatId: str(r.chat_id),
    sourceMessageId: str(r.source_message_id),
    nextFireAt: r.next_fire_at === null ? null : Number(r.next_fire_at),
    lastFiredAt: r.last_fired_at === null || r.last_fired_at === undefined ? null : Number(r.last_fired_at),
    createdAt: Number(r.created_at),
    check:
      typeof r.check_command === "string"
        ? {
            command: r.check_command,
            once: Number(r.check_once) === 1,
            hash: str(r.check_hash),
            failures: Number(r.check_failures ?? 0),
            error: str(r.check_error),
            lastCheckedAt:
              r.last_checked_at === null || r.last_checked_at === undefined ? null : Number(r.last_checked_at),
            until: r.check_until === null || r.check_until === undefined ? null : Number(r.check_until),
          }
        : null,
  };
}

function access(value: SQLInputValue | undefined): Access {
  return value === "allowed" || value === "blocked" ? value : null;
}

/** SQLITE_CONSTRAINT (19) or its extended codes, e.g. UNIQUE (2067/1555). */
function isUniqueViolation(error: unknown): boolean {
  const errcode = (error as { errcode?: number }).errcode;
  return errcode === 19 || (typeof errcode === "number" && (errcode & 0xff) === 19);
}
