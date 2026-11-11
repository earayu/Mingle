import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ChatKind, Platform } from "../channels/channel.ts";
import { shortId } from "../core/ids.ts";

export type AgentStatus = "offline" | "idle" | "thinking" | "working" | "error";
export type ConnectionStateKind = "awaiting_credentials" | "awaiting_approval" | "connected" | "reconnecting" | "error";
export type InboundState = "received" | "delivered" | "replied" | "unanswered" | "ignored";
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
  createdAt: number;
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

export interface Chat {
  id: string;
  connectionId: string;
  platformId: string;
  kind: ChatKind;
  name: string | null;
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
  nextFireAt: number | null;
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
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
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

  setAgentStatus(id: string, status: AgentStatus, detail: string | null = null): void {
    this.db
      .prepare("UPDATE agents SET status = ?, status_detail = ?, updated_at = ? WHERE id = ?")
      .run(status, detail, this.now(), id);
  }

  setSessionId(id: string, sessionId: string | null): void {
    this.db.prepare("UPDATE agents SET session_id = ?, updated_at = ? WHERE id = ?").run(sessionId, this.now(), id);
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
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

  upsertChat(input: { connectionId: string; platformId: string; kind: ChatKind; name?: string | undefined }): Chat {
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
      return this.chat(String(existing.id)) as Chat;
    }
    const id = this.mint("chats", "c", 4);
    this.db
      .prepare(
        "INSERT INTO chats (id, connection_id, platform_id, kind, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.connectionId, input.platformId, input.kind, input.name ?? null, t, t);
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

  setInboundState(ids: readonly string[], state: InboundState, inputId?: string): void {
    const stmt = this.db.prepare("UPDATE messages SET state = ?, input_id = coalesce(?, input_id) WHERE id = ?");
    for (const id of ids) stmt.run(state, inputId ?? null, id);
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

  search(agentId: string, query: string, chatId?: string, limit = 20): Message[] {
    const scope = chatId ? "AND m.chat_id = ?" : "";
    const scopeArgs = chatId ? [chatId] : [];
    // The trigram tokenizer needs three characters; shorter queries fall back to LIKE.
    const useFts = [...query].length >= 3;
    const sql = useFts
      ? `SELECT m.* FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE messages_fts MATCH ? AND n.agent_id = ? ${scope} ORDER BY m.created_at DESC LIMIT ?`
      : `SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id JOIN connections n ON n.id = c.connection_id
         WHERE m.body LIKE ? AND n.agent_id = ? ${scope} ORDER BY m.created_at DESC LIMIT ?`;
    const needle = useFts ? `"${query.replaceAll('"', '""')}"` : `%${query}%`;
    return (this.db.prepare(sql).all(needle, agentId, ...scopeArgs, limit) as Row[]).map(toMessage);
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

  createReminder(input: Omit<Reminder, "id" | "createdAt">): Reminder {
    const id = this.mint("reminders", "r", 3);
    this.db
      .prepare(
        "INSERT INTO reminders (id, agent_id, body, rule, timezone, chat_id, next_fire_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.agentId, input.body, input.rule, input.timezone, input.chatId, input.nextFireAt, this.now());
    return this.reminders(input.agentId).find((r) => r.id === id) as Reminder;
  }

  reminders(agentId: string): Reminder[] {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE agent_id = ? AND next_fire_at IS NOT NULL ORDER BY next_fire_at")
      .all(agentId) as Row[];
    return rows.map(toReminder);
  }

  dueReminders(at: number): Reminder[] {
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at")
      .all(at) as Row[];
    return rows.map(toReminder);
  }

  setReminderNext(id: string, next: number | null): void {
    this.db.prepare("UPDATE reminders SET next_fire_at = ? WHERE id = ?").run(next, id);
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

function toChat(r: Row): Chat {
  return {
    id: String(r.id),
    connectionId: String(r.connection_id),
    platformId: String(r.platform_id),
    kind: String(r.kind) as ChatKind,
    name: str(r.name),
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
    nextFireAt: r.next_fire_at === null ? null : Number(r.next_fire_at),
    createdAt: Number(r.created_at),
  };
}
