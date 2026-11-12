import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { dingtalkApi, dingtalkChannel, type StreamClientLike, toInbound } from "../src/channels/dingtalk/dingtalk.ts";
import { until } from "./helpers.ts";

/** A fake DingTalk HTTP API: routes by path, records calls. */
function fakeHttp(routes: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { path: string; method: string; body: Record<string, unknown>; url: URL; form?: FormData }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const form = init?.body instanceof FormData ? init.body : undefined;
    const body = init?.body && !form ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ path: url.pathname, method: init?.method ?? "GET", body, url, ...(form ? { form } : {}) });
    const route = routes[url.pathname];
    return Response.json(route ? route(body) : {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function fakeStream() {
  let listener: ((event: { headers: { messageId: string }; data: string }) => void) | undefined;
  const acks: string[] = [];
  const client: StreamClientLike = {
    registerCallbackListener(_topic, callback) {
      listener = callback;
    },
    socketCallBackResponse(messageId) {
      acks.push(messageId);
    },
    async connect() {},
    disconnect() {},
  };
  return {
    client,
    acks,
    push: (id: string, data: unknown) => listener?.({ headers: { messageId: id }, data: JSON.stringify(data) }),
  };
}

const base = {
  msgId: "msg1",
  conversationId: "cid1",
  senderStaffId: "staff1",
  senderNick: "张三",
  createAt: 1_700_000_000_000,
};

describe("dingtalk messages", () => {
  it("maps direct and group messages", () => {
    expect(toInbound({ ...base, conversationType: "1", msgtype: "text", text: { content: " 你好 " } })).toMatchObject({
      platformId: "msg1",
      chat: { platformId: "staff1", kind: "dm", name: "张三" },
      sender: { id: "staff1", name: "张三" },
      text: "你好",
      addressedToBot: true,
    });
    expect(
      toInbound({
        ...base,
        conversationType: "2",
        conversationTitle: "徒步群",
        isInAtList: true,
        msgtype: "text",
        text: { content: "周六？" },
      }),
    ).toMatchObject({ chat: { platformId: "cid1", kind: "group", name: "徒步群" }, addressedToBot: true });
  });

  it("lists pictures and files by download code", () => {
    const inbound = toInbound({
      ...base,
      conversationType: "1",
      msgtype: "file",
      content: { downloadCode: "dc1", fileName: "route.gpx" },
    }) as InboundMessage;
    expect(inbound.attachments).toEqual([{ id: "dc1", name: "route.gpx" }]);
  });
});

describe("dingtalk onboarding", () => {
  it("registers with Mingle's own source and returns the app credentials", async () => {
    let polls = 0;
    const http = fakeHttp({
      "/app/registration/init": () => ({ errcode: 0, nonce: "n1" }),
      "/app/registration/begin": () => ({
        errcode: 0,
        device_code: "d1",
        verification_uri_complete: "https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=AB",
        expires_in: 600,
        interval: 0.01,
      }),
      "/app/registration/poll": () =>
        ++polls < 2
          ? { errcode: 0, status: "WAITING" }
          : { errcode: 0, status: "SUCCESS", client_id: "ding1", client_secret: "sec" },
    });
    const events: OnboardingEvent[] = [];
    for await (const e of dingtalkChannel({ api: dingtalkApi(http.fetchImpl) }).onboard(
      undefined,
      new AbortController().signal,
      { agentName: "Alex" },
    )) {
      events.push(e);
    }
    expect(events.map((e) => e.kind)).toEqual(["qr_ready", "succeeded"]);
    expect(events[0]).toMatchObject({
      qrContent: "https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=AB",
    });
    expect(events[1]).toMatchObject({ credentials: { clientId: "ding1", clientSecret: "sec", name: "Alex" } });
    expect(http.calls[0]?.body).toEqual({ source: "MINGLE" });
  });
});

describe("dingtalk connection", () => {
  it("acknowledges callbacks, replies through the right API, and drives the AI card", async () => {
    const http = fakeHttp({ "/v1.0/oauth2/accessToken": () => ({ accessToken: "tok", expireIn: 7200 }) });
    const stream = fakeStream();
    const received: InboundMessage[] = [];
    const connection = await dingtalkChannel({
      api: dingtalkApi(http.fetchImpl),
      createClient: () => stream.client,
    }).connect(
      { clientId: "ding1", clientSecret: "sec", name: "Alex" },
      { onMessage: (m) => received.push(m), onState: () => {}, onMembership: () => {} },
    );
    stream.push("cb1", { ...base, conversationType: "2", isInAtList: true, msgtype: "text", text: { content: "hi" } });
    await until(() => received.length === 1, 1000);
    expect(stream.acks).toEqual(["cb1"]);

    await connection.react(received[0]?.chat as never, "msg1", "processing");
    expect(http.calls.find((c) => c.path === "/v1.0/robot/emotion/reply")?.body).toMatchObject({
      robotCode: "ding1",
      openMsgId: "msg1",
      openConversationId: "cid1",
      emotionName: "🤔思考中",
    });

    const live = await connection.startLive?.(
      { platformId: "cid1", kind: "group" },
      { replyTo: "msg1", initial: "**正在思考** · 0 秒" },
    );
    await live?.update("**正在处理** · 2 秒");
    expect(await live?.finish("答案")).toMatchObject({ kind: "sent" });
    const created = http.calls.find((c) => c.path === "/v1.0/card/instances/createAndDeliver")?.body;
    expect(created).toMatchObject({
      openSpaceId: "dtv1.card//IM_GROUP.cid1",
      imGroupOpenDeliverModel: { atUserIds: { staff1: "张三" } },
    });
    const streamed = http.calls
      .filter((c) => c.path === "/v1.0/card/streaming")
      .map((c) => [c.body.content, c.body.isFinalize]);
    expect(streamed).toEqual([
      ["**正在处理** · 2 秒", false],
      ['<a atId="staff1">@张三</a> 答案', true],
    ]);

    await connection.send({ chat: { platformId: "staff1", kind: "dm" }, text: "私聊消息" });
    expect(http.calls.find((c) => c.path === "/v1.0/robot/oToMessages/batchSend")?.body).toMatchObject({
      robotCode: "ding1",
      userIds: ["staff1"],
      msgKey: "sampleMarkdown",
    });
    await connection.close();
  });

  it("uploads files to the media store and sends images inline, other files as files", async () => {
    let media = 0;
    const http = fakeHttp({
      "/v1.0/oauth2/accessToken": () => ({ accessToken: "tok", expireIn: 7200 }),
      "/media/upload": () => ({ errcode: 0, media_id: `@media${++media}` }),
    });
    const connection = await dingtalkChannel({
      api: dingtalkApi(http.fetchImpl),
      createClient: () => fakeStream().client,
    }).connect(
      { clientId: "ding1", clientSecret: "sec" },
      { onMessage: () => {}, onState: () => {}, onMembership: () => {} },
    );
    const dir = await mkdtemp(join(tmpdir(), "mingle-dingtalk-"));
    await writeFile(join(dir, "map.png"), "png");
    await writeFile(join(dir, "plan.xlsx"), "xlsx");
    const result = await connection.send({
      chat: { platformId: "cid1", kind: "group" },
      text: "",
      files: [{ path: join(dir, "map.png") }, { path: join(dir, "plan.xlsx") }],
    });
    expect(result).toMatchObject({ kind: "sent", degraded: [] });
    const uploads = http.calls.filter((c) => c.path === "/media/upload");
    expect(uploads.map((c) => [c.url.searchParams.get("type"), c.url.searchParams.get("access_token")])).toEqual([
      ["image", "tok"],
      ["file", "tok"],
    ]);
    expect((uploads[1]?.form?.get("media") as File | undefined)?.name).toBe("plan.xlsx");
    const sent = http.calls.filter((c) => c.path === "/v1.0/robot/groupMessages/send").map((c) => c.body);
    expect(sent).toMatchObject([
      { openConversationId: "cid1", msgKey: "sampleImageMsg", msgParam: JSON.stringify({ photoURL: "@media1" }) },
      {
        msgKey: "sampleFile",
        msgParam: JSON.stringify({ mediaId: "@media2", fileName: "plan.xlsx", fileType: "xlsx" }),
      },
    ]);
    await connection.close();
  });
});
