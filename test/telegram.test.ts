import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelEvents, ConnectionState, InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { type TgMessage, telegramChannel, toInbound } from "../src/channels/telegram/telegram.ts";
import { until } from "./helpers.ts";

const TOKEN = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const me = { id: 99, is_bot: true, first_name: "Alex", username: "AlexBot" };
const zhang = { id: 1, is_bot: false, first_name: "Zhang", last_name: "San" };
const group = { id: -100, type: "supergroup" as const, title: "Hikers" };

type Reply = { ok: true; result: unknown } | { ok: false; status: number; description: string; retry_after?: number };
type Route = (body: Record<string, unknown>) => Reply | Promise<Reply>;

/** A Bot API that answers from `routes`; getUpdates hands out queued batches, then waits. */
function fakeBot(routes: Record<string, Route> = {}) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const batches: (unknown[] | Reply)[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/file/bot")) return new Response("file bytes");
    const method = url.split("/").pop() ?? "";
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body instanceof FormData) body = Object.fromEntries(init.body.entries());
    calls.push({ method, body });
    let reply: Reply;
    if (method === "getUpdates") {
      const next = batches.shift();
      if (!next) {
        // Long poll: hold until the connection closes.
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
      }
      reply = Array.isArray(next) ? { ok: true, result: next } : (next as Reply);
    } else {
      reply = (await routes[method]?.(body)) ?? { ok: true, result: method === "getMe" ? me : { message_id: 7 } };
    }
    if (!reply.ok) {
      return Response.json(
        { ok: false, description: reply.description, parameters: { retry_after: reply.retry_after } },
        { status: reply.status },
      );
    }
    return Response.json(reply);
  }) as typeof fetch;
  return { fetchImpl, calls, push: (batch: unknown[] | Reply) => batches.push(batch) };
}

function recorder() {
  const messages: InboundMessage[] = [];
  const states: ConnectionState[] = [];
  const memberships: { chat: string; joined: boolean }[] = [];
  const events: ChannelEvents = {
    onMessage: (m) => messages.push(m),
    onState: (s) => states.push(s),
    onMembership: (m) => memberships.push({ chat: m.chat.platformId, joined: m.joined }),
  } as ChannelEvents;
  return { events, messages, states, memberships };
}

const collect = async (events: AsyncIterable<OnboardingEvent>) => {
  const out: OnboardingEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const message = (overrides: Partial<TgMessage>): TgMessage => ({
  message_id: 10,
  from: zhang,
  chat: group,
  date: 1_700_000_000,
  ...(overrides.caption === undefined ? { text: "hello" } : {}),
  ...overrides,
});

let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

describe("telegram messages", () => {
  it("answers DMs, mentions, commands to it and replies to it; not other group chatter", () => {
    const dm = toInbound(message({ chat: { id: 1, type: "private", first_name: "Zhang" } }), me);
    expect(dm).toMatchObject({
      chat: { platformId: "1", kind: "dm", name: "Zhang" },
      sender: { id: "1", name: "Zhang San", isBot: false },
      addressedToBot: true,
      sentAt: 1_700_000_000_000,
    });

    expect(toInbound(message({ text: "lunch?" }), me)?.addressedToBot).toBe(false);

    const mention = toInbound(
      message({ text: "@alexbot  where to?", entities: [{ type: "mention", offset: 0, length: 8 }] }),
      me,
    );
    expect(mention).toMatchObject({ text: "where to?", addressedToBot: true });

    expect(toInbound(message({ text: "/stop@AlexBot" }), me)).toMatchObject({ text: "/stop", addressedToBot: true });

    const reply = toInbound(message({ reply_to_message: message({ message_id: 5, from: me }) }), me);
    expect(reply).toMatchObject({ replyTo: "5", addressedToBot: true });
  });

  it("keeps forum topics apart and ignores channels and senderless posts", () => {
    const topic = toInbound(
      message({
        chat: { ...group, is_forum: true },
        is_topic_message: true,
        message_thread_id: 3,
        reply_to_message: message({ message_id: 3 }),
      }),
      me,
    );
    expect(topic?.chat).toMatchObject({ platformId: "-100:3", kind: "thread" });
    // The topic's opening message is not a reply.
    expect(topic?.replyTo).toBeUndefined();

    expect(toInbound(message({ chat: { id: -5, type: "channel" } }), me)).toBeUndefined();
    const { from: _, ...anonymous } = message({});
    expect(toInbound(anonymous as TgMessage, me)).toBeUndefined();
  });

  it("lists files, keeping only the largest photo size", () => {
    const inbound = toInbound(
      message({
        caption: "the route",
        document: { file_id: "d1", file_name: "route.gpx", file_size: 12, mime_type: "application/gpx+xml" },
        photo: [
          { file_id: "small", width: 90 },
          { file_id: "big", width: 1280 },
        ],
        voice: { file_id: "v1" },
      }),
      me,
    );
    expect(inbound?.text).toBe("the route");
    expect(inbound?.attachments).toEqual([
      { id: "d1", name: "route.gpx", size: 12, mime: "application/gpx+xml" },
      { id: "big", name: "photo-10.jpg", mime: "image/jpeg" },
      { id: "v1", name: "voice-10.ogg" },
    ]);
  });
});

describe("telegram onboarding", () => {
  it("checks the token's shape before asking Telegram", async () => {
    const bot = fakeBot();
    const out = await collect(
      telegramChannel({ fetch: bot.fetchImpl }).onboard({ token: "nope" }, new AbortController().signal),
    );
    expect(out).toEqual([{ kind: "failed", code: "invalid_credentials" }]);
    expect(bot.calls).toHaveLength(0);
  });

  it("names the bot after its username, and tells a refused token from a network problem", async () => {
    const ok = await collect(
      telegramChannel({ fetch: fakeBot().fetchImpl }).onboard({ token: ` ${TOKEN} ` }, new AbortController().signal),
    );
    expect(ok).toEqual([{ kind: "succeeded", credentials: { token: TOKEN }, bot: { id: "99", name: "@AlexBot" } }]);

    const refused = fakeBot({ getMe: () => ({ ok: false, status: 401, description: "Unauthorized" }) });
    expect(
      await collect(
        telegramChannel({ fetch: refused.fetchImpl }).onboard({ token: TOKEN }, new AbortController().signal),
      ),
    ).toEqual([{ kind: "failed", code: "invalid_credentials" }]);

    const down = fakeBot({ getMe: () => ({ ok: false, status: 502, description: "Bad Gateway" }) });
    expect(
      await collect(telegramChannel({ fetch: down.fetchImpl }).onboard({ token: TOKEN }, new AbortController().signal)),
    ).toEqual([{ kind: "failed", code: "network" }]);
  });
});

describe("telegram connection", () => {
  it("delivers polled messages and group membership, and stops polling on close", async () => {
    const bot = fakeBot();
    const rec = recorder();
    bot.push([
      {
        update_id: 1,
        message: message({ text: "@AlexBot hi", entities: [{ type: "mention", offset: 0, length: 8 }] }),
      },
      { update_id: 2, my_chat_member: { chat: group, new_chat_member: { status: "member" } } },
      { update_id: 3, my_chat_member: { chat: group, new_chat_member: { status: "left" } } },
    ]);
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, rec.events);
    expect(connection.bot).toEqual({ id: "99", name: "@AlexBot" });
    await until(() => rec.memberships.length === 2);
    expect(rec.messages.map((m) => m.text)).toEqual(["hi"]);
    expect(rec.memberships).toEqual([
      { chat: "-100", joined: true },
      { chat: "-100", joined: false },
    ]);
    // The next poll asks only for what came after.
    await until(() => bot.calls.filter((c) => c.method === "getUpdates").length === 2);
    expect(bot.calls.filter((c) => c.method === "getUpdates")[1]?.body.offset).toBe(4);
    await connection.close();
  });

  it("reports a revoked token and stops", async () => {
    const bot = fakeBot();
    const rec = recorder();
    bot.push({ ok: false, status: 401, description: "Unauthorized" });
    await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, rec.events);
    await until(() => rec.states.length > 0);
    expect(rec.states).toEqual([{ kind: "error", code: "credentials_revoked" }]);
  });

  it("waits as long as Telegram asks after a failed poll, then reports connected again", async () => {
    const bot = fakeBot();
    const rec = recorder();
    bot.push({ ok: false, status: 429, description: "Too Many Requests", retry_after: 0.01 });
    bot.push([]);
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, rec.events);
    await until(() => rec.states.length === 2);
    expect(rec.states).toEqual([{ kind: "reconnecting", attempt: 1 }, { kind: "connected" }]);
    await connection.close();
  });

  it("sends text and files into the right topic, as a reply", async () => {
    dir = mkdtempSync(join(tmpdir(), "mingle-tg-"));
    const path = join(dir, "plan.txt");
    writeFileSync(path, "day 1");
    const bot = fakeBot({ sendDocument: () => ({ ok: true, result: { message_id: 8 } }) });
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, recorder().events);
    const result = await connection.send({
      chat: { platformId: "-100:3", kind: "thread" },
      text: "Here is the plan",
      files: [{ path }],
      replyTo: "10",
    });
    expect(result).toEqual({ kind: "sent", platformId: "8", degraded: ["markdown_flattened"] });
    const text = bot.calls.find((c) => c.method === "sendMessage")?.body;
    expect(text).toMatchObject({
      chat_id: -100,
      message_thread_id: 3,
      text: "Here is the plan",
      reply_parameters: { message_id: 10, allow_sending_without_reply: true },
    });
    const doc = bot.calls.find((c) => c.method === "sendDocument")?.body;
    expect(doc).toMatchObject({ chat_id: "-100", message_thread_id: "3" });
    const document = doc?.document as File;
    expect(await document.text()).toBe("day 1");
    expect(document.name).toBe("plan.txt");
    await connection.close();
  });

  it.each([
    [429, "Too Many Requests", { kind: "failed", code: "rate_limited", retryable: true }],
    [403, "Forbidden: bot was kicked", { kind: "failed", code: "forbidden", retryable: false }],
    [413, "Request Entity Too Large", { kind: "failed", code: "too_large", retryable: false }],
    [400, "Bad Request: chat not found", { kind: "failed", code: "chat_gone", retryable: false }],
    [400, "Bad Request: something else", { kind: "failed", code: "unknown", retryable: false }],
    [500, "Internal Server Error", { kind: "failed", code: "unknown", retryable: true }],
  ])("maps a %i (%s) send failure", async (status, description, expected) => {
    const bot = fakeBot({ sendMessage: () => ({ ok: false, status, description }) });
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, recorder().events);
    expect(await connection.send({ chat: { platformId: "1", kind: "dm" }, text: "hi" })).toEqual(expected);
    await connection.close();
  });

  it("does not resend when a send timed out, since it may have arrived", async () => {
    const bot = fakeBot({
      sendMessage: () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, recorder().events);
    expect(await connection.send({ chat: { platformId: "1", kind: "dm" }, text: "hi" })).toEqual({
      kind: "uncertain",
    });
    await connection.close();
  });

  it("reacts with 👀 while working and clears it when done, typing where reactions are refused", async () => {
    let refuse = false;
    const bot = fakeBot({
      setMessageReaction: () =>
        refuse ? { ok: false, status: 400, description: "REACTION_INVALID" } : { ok: true, result: true },
    });
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, recorder().events);
    const chat = { platformId: "-100:3", kind: "thread" as const };
    await connection.react(chat, "10", "processing");
    await connection.react(chat, "10", "done");
    const reactions = bot.calls.filter((c) => c.method === "setMessageReaction").map((c) => c.body.reaction);
    expect(reactions).toEqual([[{ type: "emoji", emoji: "👀" }], []]);
    refuse = true;
    await connection.react(chat, "10", "processing");
    expect(bot.calls.at(-1)).toEqual({
      method: "sendChatAction",
      body: { chat_id: -100, action: "typing", message_thread_id: 3 },
    });
    await connection.close();
  });

  it("edits one placeholder as progress comes in, in plain text, and skips unchanged edits", async () => {
    const bot = fakeBot({ sendMessage: () => ({ ok: true, result: { message_id: 20 } }) });
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, recorder().events);
    const live = await connection.startLive?.(
      { platformId: "1", kind: "dm" },
      { replyTo: "10", initial: "**Thinking**" },
    );
    await live?.update("**Thinking**");
    await live?.update("Reading *notes*");
    const done = await live?.finish("**Done**: see *map*");
    expect(bot.calls.find((c) => c.method === "sendMessage")?.body.text).toBe("Thinking");
    expect(bot.calls.filter((c) => c.method === "editMessageText").map((c) => c.body.text)).toEqual([
      "Reading notes",
      "Done: see map",
    ]);
    expect(done).toEqual({ kind: "sent", platformId: "20", degraded: ["markdown_flattened"] });
    await connection.close();
  });

  it("downloads a file, and explains when Telegram will not hand it over", async () => {
    dir = mkdtempSync(join(tmpdir(), "mingle-tg-"));
    let path: string | undefined = "documents/file_1.gpx";
    const bot = fakeBot({ getFile: () => ({ ok: true, result: path ? { file_path: path } : {} }) });
    const connection = await telegramChannel({ fetch: bot.fetchImpl }).connect({ token: TOKEN }, recorder().events);
    const to = join(dir, "route.gpx");
    await connection.download({ id: "d1", name: "route.gpx" }, to);
    expect(readFileSync(to, "utf8")).toBe("file bytes");
    path = undefined;
    await expect(connection.download({ id: "d2", name: "big.mp4" }, to)).rejects.toThrow(/20 MB/);
    await connection.close();
  });
});
