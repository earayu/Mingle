import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store/store.ts";

const schema = readFileSync(new URL("../src/store/migrations/001_init.sql", import.meta.url), "utf8");
const migrations = ["002_owner.sql", "003_failure.sql", "004_onboarding.sql"].map((f) =>
  readFileSync(new URL(`../src/store/migrations/${f}`, import.meta.url), "utf8"),
);

function open(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);
  db.exec(`
    INSERT INTO agents (id, slug, name, harness, created_at, updated_at) VALUES ('a_1', 'alex', 'Alex', 'claude', 0, 0);
    INSERT INTO connections (id, agent_id, platform, state, created_at, updated_at) VALUES ('n_1', 'a_1', 'telegram', 'connected', 0, 0);
    INSERT INTO chats (id, connection_id, platform_id, kind, created_at, updated_at) VALUES ('c1', 'n_1', '123', 'group', 0, 0);
    INSERT INTO messages (id, chat_id, direction, platform_id, body, state, created_at) VALUES ('m1', 'c1', 'in', 'p1', '周六去徒步记得带水', 'received', 0);
    INSERT INTO messages (id, chat_id, direction, platform_id, body, state, created_at) VALUES ('m2', 'c1', 'in', 'p2', 'the ridge route looks fine', 'received', 0);
  `);
  return db;
}

function search(db: DatabaseSync, query: string): string[] {
  const rows = db
    .prepare("SELECT m.id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH ?")
    .all(query);
  return rows.map((row) => String(row.id));
}

describe("initial schema", () => {
  it("finds Chinese and English text through the trigram index", () => {
    const db = open();
    expect(search(db, "去徒步")).toEqual(["m1"]);
    expect(search(db, "ridge")).toEqual(["m2"]);
  });

  it("rejects a second message with the same platform id in one chat", () => {
    const db = open();
    expect(() =>
      db.exec(
        "INSERT INTO messages (id, chat_id, direction, platform_id, body, state, created_at) VALUES ('m3', 'c1', 'in', 'p1', 'again', 'received', 0)",
      ),
    ).toThrow(/UNIQUE/);
  });

  it("removes an agent's connections, chats and messages with it", () => {
    const db = open();
    db.exec("DELETE FROM agents");
    expect(db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(0);
    expect(search(db, "ridge")).toEqual([]);
  });
});

describe("onboarding completion", () => {
  const migrate = (db: DatabaseSync) => {
    for (const sql of migrations) db.exec(sql);
  };
  const hasReplied = (db: DatabaseSync, id: string) =>
    db.prepare("SELECT has_replied FROM agents WHERE id = ?").get(id)?.has_replied === 1;

  it("backfills the flag from a sent message on upgrade, however far back", () => {
    const db = open();
    try {
      db.exec(`
        INSERT INTO agents (id, slug, name, harness, created_at, updated_at) VALUES ('a_2', 'bea', 'Bea', 'claude', 1, 1);
        INSERT INTO connections (id, agent_id, platform, state, created_at, updated_at) VALUES ('n_2', 'a_2', 'telegram', 'connected', 1, 1);
        INSERT INTO chats (id, connection_id, platform_id, kind, created_at, updated_at) VALUES ('c9', 'n_2', '55', 'dm', 1, 1);
        INSERT INTO messages (id, chat_id, direction, platform_id, body, state, created_at) VALUES ('m10', 'c1', 'out', 'o1', 'answer', 'sent', 0);
        INSERT INTO messages (id, chat_id, direction, body, state, created_at) VALUES ('m20', 'c9', 'out', 'x', 'failed', 0);
        INSERT INTO messages (id, chat_id, direction, body, state, created_at) VALUES ('m21', 'c9', 'out', 'y', 'pending', 0);
        INSERT INTO messages (id, chat_id, direction, body, state, created_at) VALUES ('m22', 'c9', 'out', 'z', 'uncertain', 0);
      `);
      for (let i = 0; i < 31; i++) {
        db.prepare(
          "INSERT INTO messages (id, chat_id, direction, platform_id, body, state, created_at) VALUES (?, 'c1', 'in', ?, 'later', 'received', ?)",
        ).run(`n${i}`, `np${i}`, i + 1);
      }
      migrate(db);
      expect(hasReplied(db, "a_1")).toBe(true);
      expect(hasReplied(db, "a_2")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("sets the flag on a newly sent message and never clears it", () => {
    const store = new Store(":memory:");
    try {
      const a1 = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
      const a2 = store.createAgent({ name: "Bea", slug: "bea", harness: "scripted" });
      const c1 = store.upsertChat({
        connectionId: store.createConnection({ agentId: a1.id, platform: "telegram", secretRef: "s1" }).id,
        platformId: "1",
        kind: "dm",
      });
      const c2 = store.upsertChat({
        connectionId: store.createConnection({ agentId: a2.id, platform: "telegram", secretRef: "s2" }).id,
        platformId: "2",
        kind: "dm",
      });

      const out = store.insertOutbound({ chatId: c1.id, body: "answer", replyTo: null });
      expect(store.agent(a1.id)?.hasReplied).toBe(false);
      store.setOutboundResult(out.id, "failed", null);
      expect(store.agent(a1.id)?.hasReplied).toBe(false);
      store.setOutboundResult(out.id, "uncertain", null);
      expect(store.agent(a1.id)?.hasReplied).toBe(false);

      // An inbound marked replied does not complete onboarding; only a sent outbound does.
      const inbound = store.insertInbound({
        chatId: c1.id,
        platformId: "p1",
        senderId: "u1",
        senderName: "Owner",
        body: "hi",
        attachments: [],
        replyTo: null,
        triggers: true,
        createdAt: Date.now(),
      });
      store.moveInbound([inbound?.id as string], "reply");
      expect(store.agent(a1.id)?.hasReplied).toBe(false);

      store.setOutboundResult(out.id, "sent", "tg-1");
      expect(store.agent(a1.id)?.hasReplied).toBe(true);
      expect(store.agent(a2.id)?.hasReplied).toBe(false);

      // A direct out/sent insert hits the INSERT trigger for the other agent.
      store.db.exec(
        `INSERT INTO messages (id, chat_id, direction, body, state, created_at) VALUES ('mx', '${c2.id}', 'out', 'answer', 'sent', 0)`,
      );
      expect(store.agent(a2.id)?.hasReplied).toBe(true);

      // Removing the connection (and its history) keeps the milestone; so do later failures.
      store.deleteConnection(store.connections(a1.id)[0]?.id as string);
      expect(store.agent(a1.id)?.hasReplied).toBe(true);
      const again = store.insertOutbound({ chatId: c2.id, body: "late", replyTo: null });
      store.setOutboundResult(again.id, "failed", null);
      store.setAgentStatus(a2.id, "error", "x", "auth");
      expect(store.agent(a2.id)?.hasReplied).toBe(true);
    } finally {
      store.close();
    }
  });

  it("persists the flag across restarts and connection removal", () => {
    const dir = mkdtempSync(join(tmpdir(), "mingle-schema-"));
    const path = join(dir, "mingle.db");
    try {
      let store = new Store(path);
      const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
      const connection = store.createConnection({ agentId: agent.id, platform: "telegram", secretRef: "s" });
      const chat = store.upsertChat({ connectionId: connection.id, platformId: "1", kind: "dm" });
      const out = store.insertOutbound({ chatId: chat.id, body: "answer", replyTo: null });
      store.setOutboundResult(out.id, "sent", "tg-1");
      store.close();

      store = new Store(path);
      expect(store.agent(agent.id)?.hasReplied).toBe(true);
      store.deleteConnection(connection.id);
      store.close();

      store = new Store(path);
      try {
        expect(store.agent(agent.id)?.hasReplied).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("contacts", () => {
  it("backfills everyone who wrote and every owner on upgrade, with the latest real name", () => {
    const dir = mkdtempSync(join(tmpdir(), "mingle-schema-"));
    const path = join(dir, "mingle.db");
    try {
      const db = new DatabaseSync(path);
      db.exec(schema);
      for (const f of ["002_owner.sql", "003_failure.sql", "004_onboarding.sql", "005_agent_env.sql"]) {
        db.exec(readFileSync(new URL(`../src/store/migrations/${f}`, import.meta.url), "utf8"));
      }
      db.exec(`
        PRAGMA user_version = 5;
        INSERT INTO agents (id, slug, name, harness, created_at, updated_at) VALUES ('a_1', 'dudu', 'Dudu', 'claude', 0, 0);
        INSERT INTO connections (id, agent_id, platform, state, owner_id, created_at, updated_at) VALUES ('n_1', 'a_1', 'wechat', 'connected', 'me@im.wechat', 0, 0);
        INSERT INTO connections (id, agent_id, platform, state, owner_id, created_at, updated_at) VALUES ('n_2', 'a_1', 'wechat', 'connected', 'her@im.wechat', 0, 0);
        INSERT INTO connections (id, agent_id, platform, state, created_at, updated_at) VALUES ('n_3', 'a_1', 'telegram', 'connected', 0, 0);
        INSERT INTO chats (id, connection_id, platform_id, kind, created_at, updated_at) VALUES ('c1', 'n_1', 'me@im.wechat', 'dm', 0, 0);
        INSERT INTO chats (id, connection_id, platform_id, kind, created_at, updated_at) VALUES ('c2', 'n_3', '-100', 'group', 0, 0);
        INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, state, created_at) VALUES ('m1', 'c1', 'in', 'p1', 'me@im.wechat', '', 'hi', 'replied', 1);
        INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, state, created_at) VALUES ('m2', 'c2', 'in', 'p2', '42', 'Zhang', 'a', 'replied', 1);
        INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, state, created_at) VALUES ('m3', 'c2', 'in', 'p3', '42', 'Zhang San', 'b', 'replied', 2);
        INSERT INTO messages (id, chat_id, direction, platform_id, sender_id, sender_name, body, state, created_at) VALUES ('m4', 'c2', 'in', 'p4', '42', '42', 'c', 'replied', 3);
      `);
      db.close();

      const store = new Store(path);
      try {
        const contacts = store.agentContacts("a_1");
        const byPlatformId = Object.fromEntries(contacts.map((k) => [k.platformId, k]));
        expect(Object.keys(byPlatformId).sort()).toEqual(["42", "her@im.wechat", "me@im.wechat"]);
        expect(byPlatformId["42"]).toMatchObject({ name: "Zhang San", alias: null, owner: false });
        expect(byPlatformId["me@im.wechat"]).toMatchObject({ name: null, owner: true, connectionId: "n_1" });
        expect(byPlatformId["her@im.wechat"]).toMatchObject({ name: null, owner: true, connectionId: "n_2" });
        expect(contacts.every((k) => /^u[2-9a-hjkmnp-z]{4}$/.test(k.id))).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the given name when the platform reports a new one, and ignores IDs posing as names", () => {
    const store = new Store(":memory:");
    try {
      const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
      const n = store.createConnection({ agentId: agent.id, platform: "telegram", secretRef: "s" });
      const first = store.touchContact(n.id, "42", "42");
      expect(first.name).toBeNull();
      expect(store.touchContact(n.id, "42", "Zhang").id).toBe(first.id);
      store.setContactAlias(first.id, "Old Zhang");
      const renamed = store.touchContact(n.id, "42", "Zhang San");
      expect(renamed).toMatchObject({ name: "Zhang San", alias: "Old Zhang" });
      expect(store.touchContact(n.id, "42", "").name).toBe("Zhang San");
      store.deleteConnection(n.id);
      expect(store.contact(first.id)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
