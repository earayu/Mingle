import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { type DiscordMessage, discordChannel, type SocketLike, toInbound } from "../src/channels/discord/discord.ts";
import { until } from "./helpers.ts";

const TOKEN = "MTIz.abc.def";

function fakeHttp(routes: Record<string, (body: unknown) => unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const path = String(input).split("/api/v10")[1] ?? String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : init?.body instanceof FormData ? init.body : undefined;
    calls.push({ method, path, body });
    const route = routes[`${method} ${path}`];
    if (!route) return new Response(null, { status: 204 });
    const result = route(body);
    if (result instanceof Response) return result;
    return Response.json(result);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const identity = {
  "GET /users/@me": () => ({ id: "B1", username: "alex", global_name: "Alex", bot: true }),
  "GET /oauth2/applications/@me": () => ({ id: "B1", flags: 1 << 19, owner: { id: "U0" } }),
  "GET /gateway/bot": () => ({ url: "wss://gateway.test" }),
};

function fakeSockets() {
  const sockets: { url: string; sent: unknown[]; socket: SocketLike; closedWith?: number | undefined }[] = [];
  const createSocket = (url: string) => {
    const entry = {
      url,
      sent: [] as unknown[],
      socket: undefined as unknown as SocketLike,
      closedWith: undefined as number | undefined,
    };
    entry.socket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: (data) => entry.sent.push(JSON.parse(data)),
      close(code) {
        entry.closedWith = code;
        queueMicrotask(() => entry.socket.onclose?.({ code: code ?? 1000 }));
      },
    };
    sockets.push(entry);
    return entry.socket;
  };
  const push = (i: number, payload: unknown) => sockets[i]?.socket.onmessage?.({ data: JSON.stringify(payload) });
  return { sockets, createSocket, push };
}

const base: DiscordMessage = {
  id: "M1",
  channel_id: "C1",
  guild_id: "G1",
  type: 0,
  author: { id: "U1", username: "zhangsan", global_name: "Zhang San" },
  content: "",
  timestamp: "2026-11-12T10:00:00.000Z",
};

const { guild_id: _guild, ...dmBase } = base;

describe("discord messages", () => {
  const group = { platformId: "C1", kind: "group" as const };
  it("keeps server chatter as context and triggers on @ and replies", () => {
    expect(toInbound({ ...base, content: "lunch?" }, "B1", group)).toMatchObject({ addressedToBot: false });
    const mention = toInbound(
      {
        ...base,
        content: "<@B1> ask <@!U2> about it",
        member: { nick: "San" },
        mentions: [
          { id: "B1", username: "alex" },
          { id: "U2", username: "lisi", global_name: "Li Si" },
        ],
      },
      "B1",
      group,
    );
    expect(mention).toMatchObject({
      text: "ask @Li Si about it",
      sender: { id: "U1", name: "San" },
      addressedToBot: true,
      sentAt: Date.parse("2026-11-12T10:00:00.000Z"),
    });
    expect(
      toInbound(
        {
          ...base,
          type: 19,
          content: "and Sunday?",
          message_reference: { message_id: "M0" },
          referenced_message: { author: { id: "B1", username: "alex" } },
        },
        "B1",
        group,
      ),
    ).toMatchObject({ replyTo: "M0", addressedToBot: true });
    expect(toInbound({ ...base, type: 7 }, "B1", group)).toBeUndefined();
    expect(toInbound({ ...base, author: { id: "B1", username: "alex" } }, "B1", group)).toBeUndefined();
    expect(toInbound({ ...dmBase, content: "hi" }, "B1", { platformId: "D1", kind: "dm" })).toMatchObject({
      addressedToBot: true,
    });
  });
});

describe("discord onboarding", () => {
  it("checks the token and takes the app owner as the bot's owner", async () => {
    const http = fakeHttp(identity);
    const events: OnboardingEvent[] = [];
    for await (const e of discordChannel({ fetch: http.fetchImpl }).onboard(
      { token: ` Bot ${TOKEN}` },
      new AbortController().signal,
    ))
      events.push(e);
    expect(events).toEqual([
      {
        kind: "succeeded",
        credentials: { token: TOKEN, name: "Alex" },
        bot: { id: "B1", name: "Alex" },
        ownerId: "U0",
      },
    ]);
    const bad: OnboardingEvent[] = [];
    for await (const e of discordChannel({ fetch: http.fetchImpl }).onboard(
      { token: "nope" },
      new AbortController().signal,
    ))
      bad.push(e);
    expect(bad).toEqual([{ kind: "failed", code: "invalid_credentials" }]);
    const revoked = fakeHttp({ "GET /users/@me": () => new Response("{}", { status: 401 }) });
    const denied: OnboardingEvent[] = [];
    for await (const e of discordChannel({ fetch: revoked.fetchImpl }).onboard(
      { token: TOKEN },
      new AbortController().signal,
    ))
      denied.push(e);
    expect(denied).toEqual([{ kind: "failed", code: "invalid_credentials" }]);
  });

  it("builds an invite link for the bot", () => {
    const url = new URL(discordChannel().inviteUrl?.({ id: "B1", name: "Alex" }) ?? "");
    expect(url.searchParams.get("client_id")).toBe("B1");
    expect(url.searchParams.get("scope")).toBe("bot");
    expect(Number(url.searchParams.get("permissions"))).toBeGreaterThan(0);
  });
});

describe("discord connection", () => {
  it("identifies with message content, resumes after a reconnect request, and maps chats", async () => {
    const http = fakeHttp({
      ...identity,
      "GET /channels/T9": () => ({ id: "T9", type: 11, name: "plans", guild_id: "G1" }),
    });
    const ws = fakeSockets();
    const received: InboundMessage[] = [];
    const states: string[] = [];
    const connection = await discordChannel({
      fetch: http.fetchImpl,
      createSocket: ws.createSocket,
      backoff: () => 1,
    }).connect(
      { token: TOKEN, name: "Alex" },
      { onMessage: (m) => received.push(m), onState: (s) => states.push(s.kind), onMembership: () => {} },
    );
    expect(connection.bot).toEqual({ id: "B1", name: "Alex" });
    expect(ws.sockets[0]?.url).toBe("wss://gateway.test/?v=10&encoding=json");

    ws.push(0, { op: 10, d: { heartbeat_interval: 60_000 } });
    const identify = ws.sockets[0]?.sent[0] as { op: number; d: { intents: number; token: string } };
    expect(identify.op).toBe(2);
    expect(identify.d.intents & (1 << 15)).toBe(1 << 15);

    ws.push(0, { op: 0, s: 1, t: "READY", d: { session_id: "S1", resume_gateway_url: "wss://resume.test" } });
    ws.push(0, {
      op: 0,
      s: 2,
      t: "GUILD_CREATE",
      d: { id: "G1", name: "Hikers", channels: [{ id: "C1", type: 0, name: "general" }] },
    });
    ws.push(0, {
      op: 0,
      s: 3,
      t: "MESSAGE_CREATE",
      d: { ...base, content: "<@B1> hi", mentions: [{ id: "B1", username: "alex" }] },
    });
    ws.push(0, {
      op: 0,
      s: 4,
      t: "MESSAGE_CREATE",
      d: { ...base, id: "M2", channel_id: "T9", content: "in a thread" },
    });
    ws.push(0, {
      op: 0,
      s: 5,
      t: "MESSAGE_CREATE",
      d: { ...base, id: "M3", guild_id: undefined, channel_id: "D1", content: "dm" },
    });
    await until(() => received.length === 3, 1000);
    const byId = Object.fromEntries(received.map((m) => [m.platformId, m.chat]));
    expect(byId.M1).toEqual({ platformId: "C1", kind: "group", name: "Hikers #general" });
    expect(byId.M2).toEqual({ platformId: "T9", kind: "thread", name: "Hikers #plans" });
    expect(byId.M3).toEqual({ platformId: "D1", kind: "dm" });

    // Discord asks for a reconnect: resume on the resume URL with the last sequence.
    ws.push(0, { op: 7, d: null });
    await until(() => ws.sockets.length === 2, 1000);
    expect(ws.sockets[1]?.url).toBe("wss://resume.test/?v=10&encoding=json");
    ws.push(1, { op: 10, d: { heartbeat_interval: 60_000 } });
    expect(ws.sockets[1]?.sent[0]).toEqual({ op: 6, d: { token: TOKEN, session_id: "S1", seq: 5 } });
    ws.push(1, { op: 0, s: 6, t: "RESUMED", d: {} });
    expect(states).toEqual(["reconnecting", "connected"]);

    await connection.close();
  });

  it("drops the Message Content intent when Discord refuses it", async () => {
    const http = fakeHttp(identity);
    const ws = fakeSockets();
    const states: string[] = [];
    await discordChannel({ fetch: http.fetchImpl, createSocket: ws.createSocket, backoff: () => 1 }).connect(
      { token: TOKEN },
      { onMessage: () => {}, onState: (s) => states.push(s.kind), onMembership: () => {} },
    );
    ws.sockets[0]?.socket.onclose?.({ code: 4014 });
    await until(() => ws.sockets.length === 2, 1000);
    ws.push(1, { op: 10, d: { heartbeat_interval: 60_000 } });
    const identify = ws.sockets[1]?.sent[0] as { op: number; d: { intents: number } };
    expect(identify.op).toBe(2);
    expect(identify.d.intents & (1 << 15)).toBe(0);
    // Refused again without it: report it instead of looping.
    ws.sockets[1]?.socket.onclose?.({ code: 4014 });
    expect(states.at(-1)).toBe("error");
  });

  it("replies, reacts, edits the live reply, and sends files in one message", async () => {
    let n = 0;
    const http = fakeHttp({ ...identity, "POST /channels/C1/messages": () => ({ id: `R${++n}` }) });
    const ws = fakeSockets();
    const connection = await discordChannel({ fetch: http.fetchImpl, createSocket: ws.createSocket }).connect(
      { token: TOKEN },
      { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
    );
    const chat = { platformId: "C1", kind: "group" as const };

    await connection.react(chat, "M1", "processing");
    await connection.react(chat, "M1", "done");
    expect(
      http.calls.filter((c) => c.path.includes("/reactions/")).map((c) => [c.method, decodeURIComponent(c.path)]),
    ).toEqual([
      ["PUT", "/channels/C1/messages/M1/reactions/👀/@me"],
      ["DELETE", "/channels/C1/messages/M1/reactions/👀/@me"],
      ["PUT", "/channels/C1/messages/M1/reactions/✅/@me"],
    ]);

    const live = await connection.startLive?.(chat, { replyTo: "M1", initial: "*Thinking* · 0s" });
    await live?.update("*Working* · 2s");
    await live?.update("*Working* · 2s");
    expect(await live?.finish("**Done**")).toEqual({ kind: "sent", platformId: "R1" });
    const first = http.calls.find((c) => c.method === "POST" && c.path === "/channels/C1/messages")?.body;
    expect(first).toMatchObject({
      content: "*Thinking* · 0s",
      message_reference: { message_id: "M1" },
      allowed_mentions: { parse: ["users"], replied_user: true },
    });
    expect(http.calls.filter((c) => c.method === "PATCH").map((c) => (c.body as { content: string }).content)).toEqual([
      "*Working* · 2s",
      "**Done**",
    ]);

    const dir = await mkdtemp(join(tmpdir(), "mingle-discord-"));
    await writeFile(join(dir, "a.txt"), "hello");
    const sent = await connection.send({ chat, text: "here", replyTo: "M1", files: [{ path: join(dir, "a.txt") }] });
    expect(sent).toEqual({ kind: "sent", platformId: "R2" });
    const form = http.calls.at(-1)?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("payload_json")))).toMatchObject({
      content: "here",
      attachments: [{ id: 0, filename: "a.txt" }],
      message_reference: { message_id: "M1" },
    });
    expect((form.get("files[0]") as File).name).toBe("a.txt");
    await connection.close();
  });

  it("maps refusals", async () => {
    const http = fakeHttp({
      ...identity,
      "POST /channels/C1/messages": () =>
        Response.json({ code: 50013, message: "Missing Permissions" }, { status: 403 }),
      "POST /channels/C2/messages": () => Response.json({ code: 10003, message: "Unknown Channel" }, { status: 404 }),
    });
    const connection = await discordChannel({
      fetch: http.fetchImpl,
      createSocket: fakeSockets().createSocket,
    }).connect({ token: TOKEN }, { onMessage: () => {}, onState: () => {}, onMembership: () => {} });
    expect(await connection.send({ chat: { platformId: "C1", kind: "group" }, text: "x" })).toMatchObject({
      code: "forbidden",
    });
    expect(await connection.send({ chat: { platformId: "C2", kind: "group" }, text: "x" })).toMatchObject({
      code: "chat_gone",
    });
    await connection.close();
  });
});
