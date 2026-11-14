import { afterEach, describe, expect, it } from "vitest";
import type { ChannelConnection, OutboundMessage, SendResult } from "../src/channels/channel.ts";
import { MingleError } from "../src/core/errors.ts";
import { Outbox } from "../src/core/outbox.ts";
import { Store } from "../src/store/store.ts";

describe("outbox with files", () => {
  let store: Store;
  afterEach(() => store.close());

  /** A connection that answers each send with the next scripted result. */
  const setup = (results: SendResult[]) => {
    store = new Store(":memory:");
    const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
    const connection = store.createConnection({ agentId: agent.id, platform: "slack", secretRef: "s1" });
    const chat = store.upsertChat({ connectionId: connection.id, platformId: "D1", kind: "dm" });
    const sends: OutboundMessage[] = [];
    const live = {
      capabilities: () => ({ maxTextLength: 4000 }),
      send: async (message: OutboundMessage) => {
        sends.push(message);
        return results.shift() ?? { kind: "sent", platformId: "unused" };
      },
    } as unknown as ChannelConnection;
    const outbox = new Outbox(store, () => live, [0, 0, 0]);
    const send = () => outbox.send(agent.id, { chatId: chat.id, text: "Attached.", files: ["/x/smoke-result.txt"] });
    return { sends, send, chatId: chat.id };
  };

  it("retries only the file once the text is out", async () => {
    const { sends, send, chatId } = setup([
      { kind: "failed", code: "unknown", retryable: true, textSent: { platformId: "5.0" } },
      { kind: "sent", platformId: "file-1" },
    ]);
    const report = await send();
    expect(sends.map((m) => m.text)).toEqual(["Attached.", ""]);
    expect(sends[1]?.files).toEqual([{ path: "/x/smoke-result.txt" }]);
    expect(report.state).toBe("sent");
    expect(store.chatMessages(chatId, 10)[0]).toMatchObject({ state: "sent", platformId: "5.0" });
  });

  it("says the text was delivered when the file never goes out, with the platform's reason", async () => {
    const { sends, send, chatId } = setup([
      {
        kind: "failed",
        code: "forbidden",
        retryable: false,
        detail: "file_uploads_disabled",
        textSent: { platformId: "5.0" },
      },
    ]);
    const error = await send().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MingleError);
    expect((error as MingleError).code).toBe("send_forbidden");
    expect((error as MingleError).next).toMatch(
      /^the text was delivered but the file was not \(slack: file_uploads_disabled\)/,
    );
    expect((error as MingleError).next).toContain("Do not send the text again");
    expect(sends).toHaveLength(1);
    // The text is recorded as sent, not failed, so the activity log matches what the person sees.
    expect(store.chatMessages(chatId, 10)[0]).toMatchObject({ state: "sent", platformId: "5.0" });
  });

  it("names the platform's reason when nothing was sent", async () => {
    const { send } = setup([{ kind: "failed", code: "unknown", retryable: false, detail: "invalid_arguments" }]);
    await expect(send()).rejects.toMatchObject({
      code: "send_unknown",
      next: "the message was not sent; try again shortly (slack: invalid_arguments)",
    });
  });
});
