import { createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ConnectionState, InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { mediaKey, toInbound, trustedBaseUrl, wechatApi, wechatChannel } from "../src/channels/wechat/wechat.ts";
import { until } from "./helpers.ts";

/** A fake iLink server: routes by endpoint, records requests. */
function fakeIlink(routes: Record<string, (body: unknown, url: URL) => unknown>) {
  const calls: { endpoint: string; url: URL; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace(/^\//, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ endpoint, url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes[endpoint];
    if (!route) return new Response("{}", { status: 404 });
    const result = await route(body, url);
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function collect(iterable: AsyncIterable<OnboardingEvent>) {
  const out: OnboardingEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}

describe("wechat login", () => {
  it("shows the QR, asks for the phone's code, and returns the bot token with the scanner as owner", async () => {
    const statuses = ["wait", "scaned", "need_verifycode", "confirmed"];
    const ilink = fakeIlink({
      "ilink/bot/get_bot_qrcode": () => ({
        qrcode: "QR1",
        qrcode_img_content: "https://liteapp.weixin.qq.com/q/abc?qrcode=QR1",
      }),
      "ilink/bot/get_qrcode_status": () => {
        const status = statuses.shift();
        return status === "confirmed"
          ? {
              status,
              bot_token: "tok",
              ilink_bot_id: "bot@im.bot",
              ilink_user_id: "owner@im.wechat",
              baseurl: "ilinkai.weixin.qq.com",
            }
          : { status };
      },
    });
    const channel = wechatChannel({ api: wechatApi(ilink.fetchImpl) });
    const events = await collect(
      channel.onboard(undefined, new AbortController().signal, { agentName: "Alex", awaitCode: async () => "123456" }),
    );
    expect(events.map((e) => e.kind)).toEqual(["qr_ready", "scanned", "needs_code", "succeeded"]);
    expect(events[0]).toMatchObject({ qrContent: "https://liteapp.weixin.qq.com/q/abc?qrcode=QR1" });
    expect(events[3]).toMatchObject({
      credentials: { token: "tok", botId: "bot@im.bot", baseUrl: "https://ilinkai.weixin.qq.com/", name: "Alex" },
      bot: { id: "bot@im.bot", name: "Alex" },
      ownerId: "owner@im.wechat",
    });
    const codeCall = ilink.calls.find((c) => c.url.searchParams.get("verify_code"));
    expect(codeCall?.url.searchParams.get("verify_code")).toBe("123456");
    expect(ilink.calls[0]?.headers["iLink-App-Id"]).toBe("bot");
  });

  it("refuses to follow a redirect away from Tencent", async () => {
    expect(() => trustedBaseUrl("https://evil.example.com", "https://ilinkai.weixin.qq.com/")).toThrow(
      /outside Tencent/,
    );
    expect(() => trustedBaseUrl("http://ilinkai.weixin.qq.com", "x")).toThrow();
    expect(trustedBaseUrl("sh.ilinkai.weixin.qq.com", "x")).toBe("https://sh.ilinkai.weixin.qq.com/");
  });

  it("sends the bots already here with the QR request, and reports an account that is one of them", async () => {
    const ilink = fakeIlink({
      "ilink/bot/get_bot_qrcode": () => ({ qrcode: "Q", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" }),
      "ilink/bot/get_qrcode_status": () => ({ status: "binded_redirect" }),
    });
    const known = Array.from({ length: 12 }, (_, i) => ({ token: `tok${i}`, botId: `b${i}` }));
    const events = await collect(
      wechatChannel({ api: wechatApi(ilink.fetchImpl) }).onboard(undefined, new AbortController().signal, {
        knownCredentials: async () => [...known, { botId: "no-token" }],
      }),
    );
    const request = ilink.calls.find((c) => c.endpoint === "ilink/bot/get_bot_qrcode");
    expect(request?.body).toEqual({ local_token_list: known.slice(0, 10).map((c) => c.token) });
    expect(events.at(-1)).toEqual({ kind: "failed", code: "already_connected" });
  });

  it("reports an account that is already bound elsewhere", async () => {
    const ilink = fakeIlink({
      "ilink/bot/get_bot_qrcode": () => ({ qrcode: "Q", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" }),
      "ilink/bot/get_qrcode_status": () => ({ status: "binded_redirect" }),
    });
    const events = await collect(
      wechatChannel({ api: wechatApi(ilink.fetchImpl) }).onboard(undefined, new AbortController().signal),
    );
    expect(events.at(-1)).toEqual({ kind: "failed", code: "already_bound" });
  });
});

describe("wechat messages", () => {
  it("maps text, voice transcripts and media placeholders, and skips the bot's own echoes", () => {
    const inbound = toInbound({
      message_id: "7300000000000000001",
      from_user_id: "u@im.wechat",
      context_token: "ctx",
      create_time_ms: 1_700_000_000_000,
      item_list: [
        { type: 1, text_item: { text: "周六去哪？" } },
        { type: 3, voice_item: { text: "带水" } },
        { type: 2 },
        { type: 4, file_item: { file_name: "route.gpx", len: "42", media: { encrypt_query_param: "q" } } },
      ],
    });
    expect(inbound).toMatchObject({
      platformId: "7300000000000000001",
      chat: { platformId: "u@im.wechat", kind: "dm" },
      sender: { id: "u@im.wechat", name: "" },
      text: "周六去哪？\n带水\n[image]",
      attachments: [{ id: "7300000000000000001#3", name: "route.gpx", size: 42 }],
      addressedToBot: true,
    });
    expect(toInbound({ message_id: "1", from_user_id: "bot", message_type: 2 })).toBeUndefined();
  });

  it("polls for messages, replies with the sender's context token, and stops on a revoked token", async () => {
    let polls = 0;
    const ilink = fakeIlink({
      "ilink/bot/msg/notifystart": () => ({ ret: 0 }),
      "ilink/bot/msg/notifystop": () => ({ ret: 0 }),
      "ilink/bot/getupdates": () => {
        polls++;
        if (polls === 1) {
          return {
            ret: 0,
            get_updates_buf: "cursor-1",
            msgs: [
              {
                message_id: "m1",
                from_user_id: "u@im.wechat",
                context_token: "ctx-1",
                item_list: [{ type: 1, text_item: { text: "hi" } }],
              },
            ],
          };
        }
        if (polls === 2) return { ret: 0, msgs: [], get_updates_buf: "cursor-2" };
        return { ret: -14 };
      },
      "ilink/bot/sendmessage": () => ({ ret: 0 }),
    });
    const received: InboundMessage[] = [];
    const states: ConnectionState[] = [];
    const connection = await wechatChannel({ api: wechatApi(ilink.fetchImpl) }).connect(
      { token: "tok", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/", name: "Alex" },
      { onMessage: (m) => received.push(m), onState: (s) => states.push(s), onMembership: () => {} },
    );
    expect(connection.bot).toEqual({ id: "bot", name: "Alex" });
    await until(() => received.length === 1, 2000);
    await until(() => states.some((s) => s.kind === "error"), 2000);
    expect(states.at(-1)).toEqual({ kind: "error", code: "credentials_revoked" });
    expect(
      ilink.calls
        .filter((c) => c.endpoint === "ilink/bot/getupdates")
        .map((c) => (c.body as { get_updates_buf: string }).get_updates_buf),
    ).toEqual(["", "cursor-1", "cursor-2"]);

    const result = await connection.send({
      chat: { platformId: "u@im.wechat", kind: "dm" },
      text: "hello",
      replyTo: "m1",
    });
    expect(result).toMatchObject({ kind: "sent", degraded: ["markdown_flattened", "quote_dropped"] });
    const sent = ilink.calls.find((c) => c.endpoint === "ilink/bot/sendmessage")?.body as {
      msg: Record<string, unknown>;
    };
    expect(sent.msg).toMatchObject({
      to_user_id: "u@im.wechat",
      context_token: "ctx-1",
      item_list: [{ type: 1, text_item: { text: "hello" } }],
    });
    const auth = ilink.calls.find((c) => c.endpoint === "ilink/bot/sendmessage")?.headers;
    expect(auth).toMatchObject({ AuthorizationType: "ilink_bot_token", Authorization: "Bearer tok" });
    await connection.close();
  });

  it("uploads files encrypted to the CDN, sends them as image or file items, and decrypts what it receives", async () => {
    const uploads: { url: URL; body: Buffer }[] = [];
    const reserved: Record<string, unknown>[] = [];
    let polled = false;
    const peerKey = Buffer.alloc(16, 7);
    const peerCipher = createCipheriv("aes-128-ecb", peerKey, null);
    const peerFile = Buffer.concat([peerCipher.update("gpx data"), peerCipher.final()]);
    const ilink = fakeIlink({
      "ilink/bot/msg/notifystart": () => ({ ret: 0 }),
      "ilink/bot/msg/notifystop": () => ({ ret: 0 }),
      "ilink/bot/getupdates": async () => {
        if (polled) {
          await new Promise((r) => setTimeout(r, 50));
          return { ret: 0, msgs: [] };
        }
        polled = true;
        return {
          ret: 0,
          msgs: [
            {
              message_id: "m1",
              from_user_id: "u@im.wechat",
              context_token: "ctx",
              item_list: [
                {
                  type: 4,
                  file_item: {
                    file_name: "route.gpx",
                    media: {
                      encrypt_query_param: "dl",
                      aes_key: Buffer.from(peerKey.toString("hex")).toString("base64"),
                    },
                  },
                },
              ],
            },
          ],
        };
      },
      "ilink/bot/getuploadurl": (body) => {
        reserved.push(body as Record<string, unknown>);
        return { ret: 0, upload_param: `up${reserved.length}` };
      },
      "ilink/bot/sendmessage": () => ({ ret: 0 }),
    });
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === "novac2c.cdn.weixin.qq.com" && url.pathname === "/c2c/upload") {
        uploads.push({ url, body: Buffer.from(init?.body as Uint8Array) });
        return new Response(null, { status: 200, headers: { "x-encrypted-param": `down${uploads.length}` } });
      }
      if (url.hostname === "novac2c.cdn.weixin.qq.com" && url.pathname === "/c2c/download")
        return new Response(peerFile);
      return ilink.fetchImpl(input, init);
    }) as typeof fetch;

    const received: InboundMessage[] = [];
    const connection = await wechatChannel({ api: wechatApi(fetchImpl) }).connect(
      { token: "tok", botId: "bot", baseUrl: "https://ilinkai.weixin.qq.com/" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} },
    );
    await until(() => received.length === 1, 2000);
    const dir = await mkdtemp(join(tmpdir(), "mingle-wechat-"));
    const attachment = received[0]?.attachments[0];
    expect(attachment).toMatchObject({ name: "route.gpx" });
    await connection.download(attachment as never, join(dir, "in.gpx"));
    expect(await readFile(join(dir, "in.gpx"), "utf8")).toBe("gpx data");

    await writeFile(join(dir, "photo.PNG"), "png bytes");
    await writeFile(join(dir, "notes.pdf"), "pdf bytes");
    const result = await connection.send({
      chat: { platformId: "u@im.wechat", kind: "dm" },
      text: "here you go",
      files: [{ path: join(dir, "photo.PNG") }, { path: join(dir, "notes.pdf") }],
    });
    expect(result).toMatchObject({ kind: "sent", degraded: ["markdown_flattened"] });
    expect(reserved.map((r) => [r.media_type, r.rawsize, r.to_user_id])).toEqual([
      [1, 9, "u@im.wechat"],
      [3, 9, "u@im.wechat"],
    ]);
    expect(uploads[0]?.url.searchParams.get("encrypted_query_param")).toBe("up1");
    expect(uploads[0]?.url.searchParams.get("filekey")).toBe(reserved[0]?.filekey);
    // The CDN gets ciphertext under the key announced in getuploadurl.
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(String(reserved[1]?.aeskey), "hex"), null);
    expect(Buffer.concat([decipher.update(uploads[1]?.body as Buffer), decipher.final()]).toString()).toBe("pdf bytes");

    const items = ilink.calls
      .filter((c) => c.endpoint === "ilink/bot/sendmessage")
      .map((c) => (c.body as { msg: { item_list: Record<string, unknown>[]; context_token: string } }).msg);
    expect(items.map((m) => m.context_token)).toEqual(["ctx", "ctx", "ctx"]);
    expect(items[0]?.item_list[0]).toMatchObject({ type: 1 });
    expect(items[1]?.item_list[0]).toMatchObject({ type: 2, image_item: { media: { encrypt_query_param: "down1" } } });
    const fileItem = items[2]?.item_list[0] as {
      type: number;
      file_item: { media: { aes_key: string }; file_name: string; len: string };
    };
    expect(fileItem).toMatchObject({ type: 4, file_item: { file_name: "notes.pdf", len: "9" } });
    expect(mediaKey(fileItem.file_item).toString("hex")).toBe(reserved[1]?.aeskey);
    await connection.close();
  });
});
