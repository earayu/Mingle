import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ChatKind, Platform } from "../channels/channel.ts";
import { shortId } from "../core/ids.ts";
import { INBOUND, type InboundEvent } from "../core/inbound.ts";
import { searchTerms } from "../core/terms.ts";

export type AgentStatus = "offline" | "idle" | "thinking" | "working" | "error" | "paused";
export type ConnectionStateKind = "awaiting_credentials" | "awaiting_approval" | "connected" | "reconnecting" | "error";
export type InboundState = "received" | "delivered" | "waiting" | "replied" | "unanswered" | "failed" | "ignored";
export type OutboundState = "pending" | "sent" | "failed" | "uncertain";
export type TaskStatus = "todo" | "in_progress" | "done" | "closed";

export interface Agent {
  id: string;
  slug: string;
  name: string;
  harness: string;
  model: string | null;
  sessionId: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  /** With status "error": the failure class (auth, quota, ...), or null when it is not known. */
  statusFailure: string | null;
  /** Whether this agent has ever successfully sent a message. */
  hasReplied: boolean;
  createdAt: number;
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
  updatedAt: number;
}

/** What to call a contact: the given name, else the platform's, else nothing. */
export function contactName(contact: Pick<Contact, "name" | "alias"> | undefined): string | null {
  return contact?.alias || contact?.name || null;
}

export interface Chat {
  id: string;
  connectionId: string;
  platformId: string;
  kind: ChatKind;
  name: string | null;
  /** The chat this thread belongs to, whose messages are its background. */
  parentId: string | null;
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
}

export interface Task {
  id: string;
  agentId: string;
  title: string;
  status: TaskStatus;
  fromMessage: string | null;
  fromChat: string | null;
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
    for (const r of senders) this.touchContact(String(r.connection_id), String(r.sender_id), str(r.name));
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

  setSessionId(id: string, sessionId: string | null): void {
    this.db.prepare("UPDATE agents SET session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, this.now(), id);
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
    patch: Partial<Pick<Connection, "botId" | "botName" | "state" | "stateDetail" | "ownerId">>,
  ): void {
    const columns: Record<string, string> = {
      botId: "bot_id",
      botName: "bot_name",
      state: "state",
      stateDetail: "state_detail",
      ownerId: "owner_id",
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
      return this.chat(String(existing.id)) as Chat;
    }
    const id = this.mint("chats", "c", 4);
    this.db
      .prepare(
        "INSERT INTO chats (id, connection_id, platform_id, kind, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.connectionId, input.platformId, input.kind, input.name ?? null, input.parentId ?? null, t, t);
    return this.chat(id) as Chat;
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
    const row = this.db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
    return row && toContact(row);
  }

  contactByPlatformId(connectionId: string, platformId: string): Contact | undefined {
    const row = this.db
      .prepare("SELECT * FROM contacts WHERE connection_id = ? AND platform_id = ?")
      .get(connectionId, platformId) as Row | undefined;
    return row && toContact(row);
  }

  /** The contact, if it belongs to one of this agent's connections. */
  agentContact(agentId: string, id: string): Contact | undefined {
    const row = this.db
      .prepare(
        "SELECT k.* FROM contacts k JOIN connections n ON n.id = k.connection_id WHERE k.id = ? AND n.agent_id = ?",
      )
      .get(id, agentId) as Row | undefined;
    return row && toContact(row);
  }

  /** Everyone this agent knows, most recently changed first. */
  agentContacts(agentId: string): (Contact & { platform: Platform; owner: boolean })[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, n.platform, (n.owner_id IS NOT NULL AND n.owner_id = k.platform_id) AS is_owner
         FROM contacts k JOIN connections n ON n.id = k.connection_id
         WHERE n.agent_id = ? ORDER BY k.updated_at DESC`,
      )
      .all(agentId) as Row[];
    return rows.map((r) => ({ ...toContact(r), platform: String(r.platform) as Platform, owner: r.is_owner === 1 }));
  }

  /** Give a contact a name, or clear it with null to go back to the platform's. */
  setContactAlias(id: string, alias: string | null): Contact | undefined {
    this.db.prepare("UPDATE contacts SET alias = ?, updated_at = ? WHERE id = ?").run(alias, this.now(), id);
    return this.contact(id);
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
        input.triggers ? "received" : "ignored",
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

  insertOutbound(input: { chatId: string; body: string; replyTo: string | null }): Message {
    const id = this.mint("messages", "m", 5);
    this.db
      .prepare(
        `INSERT INTO messages (id, chat_id, direction, body, reply_to, state, created_at) VALUES (?, ?, 'out', ?, ?, 'pending', ?)`,
      )
      .run(id, input.chatId, input.body, input.replyTo, this.now());
    return this.message(id) as Message;
  }

  setOutboundResult(id: string, state: OutboundState, platformId: string | null): void {
    this.db.prepare("UPDATE messages SET state = ?, platform_id = ? WHERE id = ?").run(state, platformId, id);
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
      `UPDATE messages SET state = ?, input_id = coalesce(?, input_id), nudged = CASE WHEN ? THEN 0 ELSE nudged END,
         retry_at = CASE WHEN ? THEN ? ELSE NULL END,
         holds = CASE WHEN ? THEN holds + 1 WHEN ? THEN 0 ELSE holds END
       WHERE id = ? AND direction = 'in' AND state IN (${rule.from.map(() => "?").join(", ")})`,
    );
    const hold = event === "hold" ? 1 : 0;
    const moved: string[] = [];
    for (const id of ids) {
      const result = stmt.run(
        rule.to,
        inputId ?? null,
        event === "retry" ? 1 : 0,
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

  messageByPlatformId(chatId: string, platformId: string): Message | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE chat_id = ? AND platform_id = ?")
      .get(chatId, platformId) as Row | undefined;
    return row && toMessage(row);
  }

  chatMessages(chatId: string, limit: number, before?: string): Message[] {
    const anchor = before ? (this.message(before)?.createdAt ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE chat_id = ? AND created_at < ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(chatId, anchor, limit) as Row[];
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
        `SELECT max(created_at) AS at FROM messages WHERE direction = 'out' AND state IN ('sent', 'uncertain')
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

  /** Delivered inbound messages for this agent that nobody has answered yet. */
  awaitingReply(agentId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE n.agent_id = ? AND m.direction = 'in' AND m.state = 'delivered' ORDER BY m.created_at`,
      )
      .all(agentId) as Row[];
    return rows.map(toMessage);
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
                max(CASE WHEN m.direction = 'out' AND m.state = 'sent' THEN m.created_at END) AS out_at
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

  setTaskStatus(agentId: string, id: string, status: TaskStatus): Task | undefined {
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND agent_id = ?")
      .run(status, this.now(), id, agentId);
    return this.task(agentId, id);
  }

  // --------------------------------------------------------------- reminders

  createReminder(
    input: Omit<Reminder, "id" | "createdAt" | "lastFiredAt" | "sourceMessageId"> & { sourceMessageId?: string | null },
  ): Reminder {
    const id = this.mint("reminders", "r", 3);
    this.db
      .prepare(
        `INSERT INTO reminders (id, agent_id, body, rule, timezone, chat_id, source_message_id, next_fire_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /** Reminders that are due, except a paused agent's: they wait and fire once it resumes. */
  dueReminders(at: number): Reminder[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM reminders r JOIN agents a ON a.id = r.agent_id
         WHERE r.next_fire_at IS NOT NULL AND r.next_fire_at <= ? AND a.status != 'paused' ORDER BY r.next_fire_at`,
      )
      .all(at) as Row[];
    return rows.map(toReminder);
  }

  /** A reminder fired at `at`; `next` is when it fires again, null for a one-off. */
  markReminderFired(id: string, at: number, next: number | null): void {
    this.db.prepare("UPDATE reminders SET next_fire_at = ?, last_fired_at = ? WHERE id = ?").run(next, at, id);
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
}

const str = (v: SQLInputValue | undefined): string | null => (v === null || v === undefined ? null : String(v));

function toAgent(r: Row): Agent {
  return {
    id: String(r.id),
    slug: String(r.slug),
    name: String(r.name),
    harness: String(r.harness),
    model: str(r.model),
    sessionId: str(r.session_id),
    status: String(r.status) as AgentStatus,
    statusDetail: str(r.status_detail),
    statusFailure: str(r.status_failure),
    hasReplied: Number(r.has_replied) === 1,
    createdAt: Number(r.created_at),
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
  };
}

function toContact(r: Row): Contact {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    platformId: String(r.platform_id),
    name: str(r.name),
    alias: str(r.alias),
    updatedAt: Number(r.updated_at),
  };
}

function toChat(r: Row): Chat {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    platformId: String(r.platform_id),
    kind: String(r.kind) as ChatKind,
    name: str(r.name),
    parentId: str(r.parent_id),
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
  };
}
