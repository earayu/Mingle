import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../src/store/migrations/001_init.sql", import.meta.url), "utf8");

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
