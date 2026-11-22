import { mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createHome, readRole, writeRole } from "../src/core/home.ts";
import { Store } from "../src/store/store.ts";
import { type Rig, rig } from "./helpers.ts";

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

describe("admin API conditional GET", () => {
  it("returns ETag on GET JSON and 304 on matching If-None-Match until state changes", async () => {
    current = await rig(async () => {});
    const url = `${current.url}/v1/admin/status`;
    const auth = { authorization: `Bearer ${current.mingle.adminToken}` };

    const first = await fetch(url, { headers: auth });
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");
    const body = await first.json();
    expect(Array.isArray((body as { agents: unknown[] }).agents)).toBe(true);

    const second = await fetch(url, { headers: { ...auth, "if-none-match": etag as string } });
    expect(second.status).toBe(304);
    expect(second.headers.get("etag")).toBe(etag);
    expect(await second.text()).toBe("");

    // Comma-separated If-None-Match lists also match.
    const third = await fetch(url, { headers: { ...auth, "if-none-match": `W/"stale", ${etag as string}` } });
    expect(third.status).toBe(304);

    // Mutating state produces a fresh ETag and a 200 payload.
    await current.admin("POST", "/v1/admin/agents", { name: "Nova", harness: "scripted" });
    const fourth = await fetch(url, { headers: { ...auth, "if-none-match": etag as string } });
    expect(fourth.status).toBe(200);
    const nextEtag = fourth.headers.get("etag");
    expect(nextEtag).toBeTruthy();
    expect(nextEtag).not.toBe(etag);
  });
});

describe("ROLE.md stat-validated cache", () => {
  it("serves cached content and invalidates on writeRole, external edits, and deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "mingle-role-cache-"));
    try {
      createHome(dir, "Alex", "Initial role");
      expect(readRole(dir)).toBe("Initial role\n");
      // Second read hits the cache.
      expect(readRole(dir)).toBe("Initial role\n");

      // writeRole updates both disk and cache immediately.
      writeRole(dir, "Updated via writeRole");
      expect(readRole(dir)).toBe("Updated via writeRole\n");

      // External edit with updated content / mtime invalidates cache.
      const rolePath = join(dir, "ROLE.md");
      writeFileSync(rolePath, "Edited externally\n");
      const future = new Date(Date.now() + 5000);
      utimesSync(rolePath, future, future);
      expect(readRole(dir)).toBe("Edited externally\n");

      // Deleting the file invalidates cache and returns empty string.
      unlinkSync(rolePath);
      expect(readRole(dir)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SQLite performance indexes and prepared statements", () => {
  it("installs migration 034 indexes and serves repeated queries cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "mingle-idx-"));
    const dbPath = join(dir, "mingle.db");
    try {
      const store = new Store(dbPath);
      const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
      const conn = store.createConnection({ agentId: agent.id, platform: "telegram", secretRef: "s1" });
      const chat = store.upsertChat({ connectionId: conn.id, platformId: "1", kind: "dm" });
      store.insertInbound({
        chatId: chat.id,
        platformId: "p1",
        senderId: "u1",
        senderName: "Owner",
        body: "hello",
        attachments: [],
        replyTo: null,
        triggers: true,
        createdAt: Date.now(),
      });
      // Repeated reads exercise cached prepared statements.
      expect(store.agent(agent.id)?.name).toBe("Alex");
      expect(store.agent(agent.id)?.name).toBe("Alex");
      expect(store.agentChats(agent.id)).toHaveLength(1);
      expect(store.agentChats(agent.id)).toHaveLength(1);
      expect(store.agentActivity(agent.id, 10)).toHaveLength(1);
      expect(store.agentActivity(agent.id, 10)).toHaveLength(1);
      store.close();

      const raw = new DatabaseSync(dbPath);
      try {
        const names = (
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('reminders_agent', 'messages_chat_attention')",
            )
            .all() as { name: string }[]
        )
          .map((r) => r.name)
          .sort();
        expect(names).toEqual(["messages_chat_attention", "reminders_agent"]);
      } finally {
        raw.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
