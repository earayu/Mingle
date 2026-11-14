import { describe, expect, it } from "vitest";
import { formatMessage } from "../src/core/format.ts";
import { Store } from "../src/store/store.ts";

/** Group messages that were not addressed to the agent (docs/spec.md 4.2). */
describe("background messages", () => {
  function setup() {
    let clock = 1000;
    const store = new Store(":memory:", () => clock);
    const agent = store.createAgent({ name: "Alex", slug: "alex", harness: "scripted" });
    const connectionId = store.createConnection({ agentId: agent.id, platform: "slack", secretRef: "s" }).id;
    let seq = 0;
    const say = (chatId: string, triggers: boolean, body = "x") => {
      clock += 10;
      return store.insertInbound({
        chatId,
        platformId: `p${seq++}`,
        senderId: "U1",
        senderName: "Zhang San",
        body,
        attachments: [],
        replyTo: null,
        triggers,
        createdAt: clock,
      }) as NonNullable<ReturnType<Store["insertInbound"]>>;
    };
    const speak = (chatId: string, state: "sent" | "failed" | "uncertain" = "sent") => {
      clock += 10;
      const message = store.insertOutbound({ chatId, body: "ok", replyTo: null });
      store.setOutboundResult(message.id, state, state === "sent" ? `p-${message.id}` : null);
      return message;
    };
    return { store, connectionId, say, speak };
  }

  it("counts what was said in a group since the agent last spoke there", () => {
    const { store, connectionId, say, speak } = setup();
    const group = store.upsertChat({ connectionId, platformId: "G", kind: "group", name: "Hikes" });
    const other = store.upsertChat({ connectionId, platformId: "H", kind: "group" });
    say(group.id, false);
    say(group.id, false);
    say(other.id, false); // Another group's chatter is not this one's.
    const first = say(group.id, true);
    expect(store.unseen(group.id, first.createdAt)).toBe(2);

    speak(group.id);
    say(group.id, true); // Addressed messages reached the agent; they are not unseen.
    const chatter = say(group.id, false);
    const second = say(group.id, true);
    expect(store.unseen(group.id, second.createdAt)).toBe(1);
    // Counted as of the message: chatter after it does not change an earlier header.
    say(group.id, false);
    expect(store.unseen(group.id, second.createdAt)).toBe(1);
    expect(store.unseen(group.id, chatter.createdAt)).toBe(0);
  });

  it("does not count a reply that never reached the chat as having spoken", () => {
    const { store, connectionId, say, speak } = setup();
    const group = store.upsertChat({ connectionId, platformId: "G", kind: "group" });
    say(group.id, false);
    speak(group.id, "failed");
    say(group.id, false);
    const trigger = say(group.id, true);
    // The failed send is not "spoke": both messages before it still count.
    expect(store.unseen(group.id, trigger.createdAt)).toBe(2);

    speak(group.id, "uncertain");
    say(group.id, false);
    const next = say(group.id, true);
    expect(store.unseen(group.id, next.createdAt)).toBe(1);
  });

  it("counts a thread's channel, and resets when the agent speaks in any of its threads", () => {
    const { store, connectionId, say, speak } = setup();
    const channel = store.upsertChat({ connectionId, platformId: "C1", kind: "group" });
    const thread = store.upsertChat({ connectionId, platformId: "C1:2", kind: "thread", parentId: channel.id });
    const sibling = store.upsertChat({ connectionId, platformId: "C1:3", kind: "thread", parentId: channel.id });
    expect(thread.parentId).toBe(channel.id);
    say(channel.id, false);
    say(channel.id, false);
    say(channel.id, false);
    const mention = say(thread.id, true);
    expect(store.unseen(thread.id, mention.createdAt)).toBe(3);

    speak(sibling.id);
    say(channel.id, false);
    const next = say(thread.id, true);
    expect(store.unseen(thread.id, next.createdAt)).toBe(1);
  });

  it("puts the count and the parent chat in the header", () => {
    const { store, connectionId, say } = setup();
    const channel = store.upsertChat({ connectionId, platformId: "C1", kind: "group" });
    const thread = store.upsertChat({ connectionId, platformId: "C1:2", kind: "thread", parentId: channel.id });
    const message = say(thread.id, true, "what do you think?");
    const header = (unseen: number) => formatMessage(message, thread, "slack", { unseen }).split("\n")[0];
    expect(header(4)).toMatch(
      new RegExp(`^\\[msg=${message.id} chat=${thread.id} im=slack group="C1:2" in=${channel.id} .+ unseen=4\\]$`),
    );
    expect(header(0)).not.toContain("unseen");
  });

  it("reads the messages after one with --since, oldest first", () => {
    const { store, connectionId, say, speak } = setup();
    const group = store.upsertChat({ connectionId, platformId: "G", kind: "group" });
    const anchor = say(group.id, true, "a");
    say(group.id, false, "b");
    speak(group.id);
    say(group.id, false, "c");
    expect(store.chatSince(group.id, anchor.id, 30)?.map((m) => m.body)).toEqual(["b", "ok", "c"]);
    expect(store.chatSince(group.id, anchor.id, 1)?.map((m) => m.body)).toEqual(["b"]);
    const other = store.upsertChat({ connectionId, platformId: "H", kind: "group" });
    expect(store.chatSince(other.id, anchor.id, 30)).toBeUndefined();
  });
});
