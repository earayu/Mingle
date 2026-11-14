import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { SLACK_SETUP_URL, type SocketLike, slackChannel, toInbound } from "../src/channels/slack/slack.ts";
import { until } from "./helpers.ts";

const names = async (id: string) => ({ U1: "Zhang San", U2: "Li Si" })[id] ?? "";

type Route = (body: Record<string, unknown>) => Record<string, unknown>;

function fakeHttp(routes: Record<string, Route>) {
  const calls: { method: string; body: Record<string, unknown>; form?: boolean; bytes?: string }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const method = String(input).split("/api/")[1] ?? String(input);
    const type = new Headers(init?.headers).get("content-type") ?? "";
    if (init?.body instanceof Blob) {
      calls.push({ method, body: {}, bytes: await init.body.text() });
      return new Response("OK");
    }
    const form = type.startsWith("application/x-www-form-urlencoded");
    const raw = typeof init?.body === "string" ? init.body : "";
    // Like Slack: files.getUploadURLExternal reads form fields only and sees nothing in a JSON body.
    const body = form
      ? Object.fromEntries(new URLSearchParams(raw))
      : raw && method !== "files.getUploadURLExternal"
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
    calls.push({ method, body, form });
    const route = routes[method];
    return Response.json(route ? { ok: true, ...route(body) } : { ok: true });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function fakeSocket() {
  const sent: string[] = [];
  const socket: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => sent.push(data),
    close() {},
  };
  return { socket, sent, push: (data: unknown) => socket.onmessage?.({ data: JSON.stringify(data) }) };
}

const auth = () => ({ user_id: "UBOT", user: "alex", bot_id: "B1" });

describe("slack messages", () => {
  it("takes DMs, mentions and threads it is in; ignores the rest", async () => {
    const threads = new Set<string>();
    const dm = await toInbound(
      { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hi &amp; bye", ts: "1700000000.000100" },
      "UBOT",
      names,
      threads,
    );
    expect(dm).toMatchObject({
      chat: { platformId: "D1", kind: "dm" },
      sender: { id: "U1", name: "Zhang San" },
      text: "hi & bye",
      sentAt: 1_700_000_000_000,
    });

    const chatter = { type: "message", channel: "C1", channel_type: "channel", user: "U1", ts: "2.0" };
    expect(await toInbound({ ...chatter, text: "lunch?" }, "UBOT", names, threads)).toBeUndefined();

    const mention = await toInbound(
      { ...chatter, text: "<@UBOT> ask <@U2> about <https://x.org|this>" },
      "UBOT",
      names,
      threads,
    );
    expect(mention).toMatchObject({
      chat: { platformId: "C1:2.0", kind: "thread" },
      text: "ask @Li Si about this (https://x.org)",
    });
    // A follow-up in that thread needs no @.
    expect(
      await toInbound({ ...chatter, ts: "3.0", thread_ts: "2.0", text: "and Sunday?" }, "UBOT", names, threads),
    ).toMatchObject({ chat: { platformId: "C1:2.0" }, text: "and Sunday?" });
    expect(
      await toInbound({ ...chatter, bot_id: "B1", user: "UBOT", text: "<@UBOT>" }, "UBOT", names, threads),
    ).toBeUndefined();
    expect(
      await toInbound({ ...chatter, subtype: "message_changed", text: "<@UBOT>" }, "UBOT", names, threads),
    ).toBeUndefined();
  });

  it("prefills the app manifest", () => {
    const manifest = JSON.parse(new URL(SLACK_SETUP_URL).searchParams.get("manifest_json") ?? "{}");
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.oauth_config.scopes.bot).toContain("chat:write");
    expect(manifest.features.bot_user.display_name).toBe("__MINGLE_AGENT_HANDLE__");
  });
});

describe("slack onboarding", () => {
  it("checks both tokens", async () => {
    const http = fakeHttp({
      "auth.test": auth,
      "apps.connections.open": () => ({ url: "wss://x" }),
      "users.info": () => ({ user: { name: "alex", profile: { display_name: "Alex" } } }),
    });
    const events: OnboardingEvent[] = [];
    for await (const e of slackChannel({ fetch: http.fetchImpl }).onboard(
      { botToken: "xoxb-1", appToken: "xapp-1" },
      new AbortController().signal,
    )) {
      events.push(e);
    }
    expect(events).toMatchObject([{ kind: "succeeded", bot: { id: "UBOT", name: "Alex" } }]);
    const bad: OnboardingEvent[] = [];
    for await (const e of slackChannel({ fetch: http.fetchImpl }).onboard(
      { botToken: "xapp-1", appToken: "xoxb-1" },
      new AbortController().signal,
    )) {
      bad.push(e);
    }
    expect(bad).toEqual([{ kind: "failed", code: "invalid_credentials" }]);
  });
});

describe("slack connection", () => {
  it("acks envelopes once, reacts, edits the live reply, and replies in the thread", async () => {
    const http = fakeHttp({
      "auth.test": auth,
      "apps.connections.open": () => ({ url: "wss://x" }),
      "users.info": () => ({ user: { name: "zs", real_name: "Zhang San" } }),
      "chat.postMessage": () => ({ ts: "9.0" }),
    });
    const ws = fakeSocket();
    const received: InboundMessage[] = [];
    const connection = await slackChannel({ fetch: http.fetchImpl, createSocket: () => ws.socket }).connect(
      { botToken: "xoxb-1", appToken: "xapp-1", name: "Alex" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} },
    );
    const envelope = {
      type: "events_api",
      envelope_id: "e1",
      payload: {
        event_id: "Ev1",
        event: { type: "message", channel: "C1", channel_type: "channel", user: "U1", text: "<@UBOT> hi", ts: "2.0" },
      },
    };
    ws.push({ type: "hello" });
    ws.push(envelope);
    ws.push({ ...envelope, envelope_id: "e2" }); // Slack's retry of the same event.
    await until(() => received.length === 1, 1000);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(ws.sent.map((s) => JSON.parse(s).envelope_id)).toEqual(["e1", "e2"]);

    const chat = received[0]?.chat as never;
    await connection.react(chat, "2.0", "processing");
    await connection.react(chat, "2.0", "done");
    expect(http.calls.filter((c) => c.method.startsWith("reactions.")).map((c) => [c.method, c.body.name])).toEqual([
      ["reactions.add", "eyes"],
      ["reactions.remove", "eyes"],
      ["reactions.add", "white_check_mark"],
    ]);

    const live = await connection.startLive?.(chat, { replyTo: "2.0", mention: "U1", initial: "**Thinking** · 0s" });
    await live?.update("**Working** · 2s");
    expect(await live?.finish("Answer")).toEqual({ kind: "sent", platformId: "9.0" });
    expect(http.calls.find((c) => c.method === "chat.postMessage")?.body).toMatchObject({
      channel: "C1",
      thread_ts: "2.0",
      blocks: [{ type: "markdown", text: "**Thinking** · 0s" }],
    });
    expect(http.calls.filter((c) => c.method === "chat.update").map((c) => c.body.text)).toEqual([
      "**Working** · 2s",
      "<@U1> Answer",
    ]);
    await connection.close();
  });
});

describe("slack files", () => {
  const UPLOAD = "https://files.slack.com/upload/v1/signed";
  const connect = async (routes: Record<string, Route>) => {
    const http = fakeHttp({ "auth.test": auth, "apps.connections.open": () => ({ url: "wss://x" }), ...routes });
    const ws = fakeSocket();
    const connection = await slackChannel({ fetch: http.fetchImpl, createSocket: () => ws.socket }).connect(
      { botToken: "xoxb-1", appToken: "xapp-1", name: "Alex" },
      { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
    );
    return { http, connection };
  };
  const withFile = async (run: (path: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), "mingle-slack-"));
    const path = join(dir, "smoke-result.txt");
    writeFileSync(path, "MINGLE-FILE-OK");
    try {
      await run(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const dm = { platformId: "D1", kind: "dm" as const };

  it("reserves the upload with form fields, sends the bytes, then shares the file after the text", async () => {
    await withFile(async (path) => {
      const { http, connection } = await connect({
        // Slack answers missing_argument when filename and length are not form fields.
        "files.getUploadURLExternal": (body) =>
          body.filename && body.length
            ? { upload_url: UPLOAD, file_id: "F1" }
            : { ok: false, error: "missing_argument" },
        "chat.postMessage": () => ({ ts: "5.0" }),
      });
      expect(await connection.send({ chat: dm, text: "Attached.", files: [{ path }] })).toEqual({
        kind: "sent",
        platformId: "5.0",
      });
      const steps = http.calls.filter((c) => !["auth.test", "apps.connections.open"].includes(c.method));
      expect(steps.map((c) => c.method)).toEqual([
        "files.getUploadURLExternal",
        UPLOAD,
        "chat.postMessage",
        "files.completeUploadExternal",
      ]);
      expect(steps[0]).toMatchObject({ form: true, body: { filename: "smoke-result.txt", length: "14" } });
      expect(steps[1]?.bytes).toBe("MINGLE-FILE-OK");
      expect(steps[3]?.body).toEqual({ files: [{ id: "F1", title: "smoke-result.txt" }], channel_id: "D1" });
      await connection.close();
    });
  });

  it("posts nothing when Slack refuses the file, and names Slack's reason", async () => {
    await withFile(async (path) => {
      const { http, connection } = await connect({
        "files.getUploadURLExternal": () => ({ ok: false, error: "file_uploads_disabled" }),
      });
      expect(await connection.send({ chat: dm, text: "Attached.", files: [{ path }] })).toEqual({
        kind: "failed",
        code: "forbidden",
        retryable: false,
        detail: "file_uploads_disabled",
      });
      expect(http.calls.some((c) => c.method === "chat.postMessage")).toBe(false);
      await connection.close();
    });
  });

  it("reports the text as sent when only sharing the file fails", async () => {
    await withFile(async (path) => {
      const { connection } = await connect({
        "files.getUploadURLExternal": () => ({ upload_url: UPLOAD, file_id: "F1" }),
        "chat.postMessage": () => ({ ts: "5.0" }),
        "files.completeUploadExternal": () => ({ ok: false, error: "internal_error" }),
      });
      expect(await connection.send({ chat: dm, text: "Attached.", files: [{ path }] })).toEqual({
        kind: "failed",
        code: "unknown",
        retryable: true,
        detail: "internal_error",
        textSent: { platformId: "5.0" },
      });
      await connection.close();
    });
  });
});
