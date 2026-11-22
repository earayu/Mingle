import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mimeOf } from "../src/core/mingle.ts";
import { eventually, messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** The owner's private chat in the console (docs/spec.md 6.9). */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

type ChatMessage = {
  id: string;
  direction: "in" | "out";
  body: string;
  state: string;
  files: { id: string; name: string; size: number | null; mime: string | null }[];
};
type Chat = { messages: ChatMessage[]; more: boolean };
type Status = {
  agents: {
    id: string;
    hasReplied: boolean;
    connections: { platform: string }[];
    chat: { unread: number; last: { preview: string } | null };
  }[];
};

async function upload(r: Rig, name: string, bytes: string): Promise<{ id: string; name: string; size: number }> {
  const response = await fetch(`${r.url}/v1/admin/agents/${r.agentId}/chat/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${r.mingle.adminToken}`,
      "content-type": "text/plain",
      "x-file-name": encodeURIComponent(name),
    },
    body: bytes,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string; size: number };
}

describe("private chat in the console", () => {
  it("is a direct chat with the owner that the agent answers like any other, hidden among the chat apps", async () => {
    current = await rig(async (t) => {
      for (const id of messageIds(t.input)) {
        const result = await runCli(t.options.env as Record<string, string>, ["message", "reply", id], `sure ${id}`);
        if (result.code !== 0) throw new Error(result.stderr);
      }
    });
    const r = current;
    const status = (await r.admin("GET", "/v1/admin/status")).json as Status;
    // Built in: not one of the chat apps the owner added.
    expect(status.agents[0]?.connections.map((c) => c.platform)).toEqual(["telegram"]);
    expect(status.agents[0]?.chat).toEqual({ unread: 0, last: null });
    expect((await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat`)).json).toEqual({ messages: [], more: false });

    const sent = await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "  what's on today?  " });
    expect(sent.status).toBe(201);
    const asked = sent.json as ChatMessage;
    expect(asked).toMatchObject({ direction: "in", body: "what's on today?" });

    await until(() => r.turns[0]);
    // The owner, in a direct chat; no name, since the console has none to give.
    expect(r.turns[0]?.input).toMatch(
      /^\[msg=m\w+ chat=c\w+ im=local dm user=u\w+ owner time=.+\]\nwhat's on today\?$/,
    );
    const chat = await eventually(async () => {
      const read = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat`)).json as Chat;
      return read.messages.length === 2 && read.messages[0]?.state === "replied" ? read : undefined;
    });
    expect(chat.messages.map((m) => [m.direction, m.body])).toEqual([
      ["in", "what's on today?"],
      ["out", `sure ${asked.id}`],
    ]);
    // Nothing went to the chat app.
    expect(r.channel.sent).toEqual([]);

    const after = (await r.admin("GET", "/v1/admin/status")).json as Status;
    // Getting started is about the chat apps: an answer here does not complete it.
    expect(after.agents[0]?.hasReplied).toBe(false);
    // The owner just wrote there, so the answer counts as seen.
    expect(after.agents[0]?.chat.unread).toBe(0);
    // The agent's contacts are the people in its chat apps.
    expect(r.mingle.store.agentContacts(r.agentId)).toEqual([]);
  });

  it("counts what the agent says there until the owner looks", async () => {
    current = await rig(async () => {});
    const r = current;
    await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "remind me later" });
    const chat = r.mingle.localChatOf(r.agentId);
    expect(chat).toBeDefined();
    // Long after the owner looked: what the agent sends now is new to them.
    await new Promise((resolve) => setTimeout(resolve, 5100));
    await r.mingle.outbox.send(r.agentId, { chatId: chat?.id as string, text: "Time to call the landlord." });
    const summary = (await r.admin("GET", "/v1/admin/summary")).json as {
      agents: { connections: unknown[]; chat: { unread: number; last: { preview: string } | null } }[];
    };
    expect(summary.agents[0]?.connections).toHaveLength(1);
    expect(summary.agents[0]?.chat).toMatchObject({ unread: 1, last: { preview: "Time to call the landlord." } });

    await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat?watching=1`);
    const seen = (await r.admin("GET", "/v1/admin/status")).json as Status;
    expect(seen.agents[0]?.chat.unread).toBe(0);
  }, 15_000);

  it("carries files both ways", async () => {
    let downloaded = "";
    current = await rig(async (t) => {
      const env = t.options.env as Record<string, string>;
      const file = /file=(f\w+):/.exec(t.input)?.[1];
      if (!file) return;
      const into = join(t.options.cwd as string, "notes.txt");
      const got = await runCli(env, ["file", "get", file, "--out", into]);
      if (got.code !== 0) throw new Error(got.stderr);
      downloaded = readFileSync(into, "utf8");
      const out = join(t.options.cwd as string, "answer.md");
      writeFileSync(out, "# done");
      const [id] = messageIds(t.input);
      const sent = await runCli(env, ["message", "reply", id as string, "--file", out], "Here it is.");
      if (sent.code !== 0) throw new Error(sent.stderr);
    });
    const r = current;
    const file = await upload(r, "notes.txt", "milk, eggs");
    expect(file).toMatchObject({ name: "notes.txt", size: 10 });
    const sent = await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "", files: [file.id] });
    expect(sent.status).toBe(201);
    expect((sent.json as ChatMessage).files).toMatchObject([{ name: "notes.txt", size: 10, mime: "text/plain" }]);

    const answer = await eventually(async () => {
      const read = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat`)).json as Chat;
      return read.messages.find((m) => m.direction === "out");
    });
    expect(downloaded).toBe("milk, eggs");
    expect(answer.body).toBe("Here it is.");
    expect(answer.files).toMatchObject([{ name: "answer.md", size: 6, mime: "text/markdown" }]);
    const bytes = await fetch(`${r.url}/v1/admin/agents/${r.agentId}/chat/files/${answer.files[0]?.id}`, {
      headers: { authorization: `Bearer ${r.mingle.adminToken}` },
    });
    expect(bytes.status).toBe(200);
    expect(await bytes.text()).toBe("# done");

    // An unknown upload, or a file of another chat, is not found.
    expect((await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { files: ["AAAAAAAAAAAA"] })).status).toBe(404);
    expect((await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat/files/fnope`)).status).toBe(404);
    expect((await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "  " })).status).toBe(400);
  });

  it("keeps the private chat of a paused agent quiet, without Mingle's notice in it", async () => {
    current = await rig(async () => {});
    const r = current;
    await r.admin("POST", `/v1/admin/agents/${r.agentId}/pause`);
    await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "are you there?" });
    const chat = await eventually(async () => {
      const read = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat`)).json as Chat;
      return read.messages[0]?.state === "ignored" ? read : undefined;
    });
    expect(chat.messages).toHaveLength(1);
    expect(r.turns).toEqual([]);
  });

  it("paginates past Mingle notices without truncating pages or dropping `more`", async () => {
    current = await rig(async () => {});
    const r = current;
    await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "first" });
    await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "second" });
    const chat = r.mingle.localChatOf(r.agentId);
    expect(chat).toBeDefined();
    // Insert a Mingle notice between normal messages.
    r.mingle.store.insertOutbound({ chatId: chat?.id as string, body: "system notice", replyTo: null, notice: true });
    await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "third" });

    const latest = (await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat?limit=2`)).json as Chat;
    expect(latest.messages.map((m) => m.body)).toEqual(["second", "third"]);
    expect(latest.more).toBe(true);

    const earlier = (
      await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat?limit=2&before=${latest.messages[0]?.id}`)
    ).json as Chat;
    expect(earlier.messages.map((m) => m.body)).toEqual(["first"]);
    expect(earlier.more).toBe(false);
  });

  it("ignores extensionless names in mimeOf and returns 404 when a chat file path is a directory", async () => {
    expect(mimeOf("json")).toBeUndefined();
    expect(mimeOf("png")).toBeUndefined();
    expect(mimeOf(".png")).toBeUndefined();
    expect(mimeOf("photo.PNG")).toBe("image/png");

    current = await rig(async () => {});
    const r = current;
    await r.admin("POST", `/v1/admin/agents/${r.agentId}/chat`, { text: "hi" });
    const chat = r.mingle.localChatOf(r.agentId);
    const dir = join(r.home, "not-a-file");
    mkdirSync(dir, { recursive: true });
    const record = r.mingle.store.insertOutbound({
      chatId: chat?.id as string,
      body: "attached",
      replyTo: null,
      attachments: [{ ref: dir, name: "not-a-file" }],
    });
    const fileId = record.attachments[0]?.id as string;
    expect((await r.admin("GET", `/v1/admin/agents/${r.agentId}/chat/files/${fileId}`)).status).toBe(404);
  });
});
