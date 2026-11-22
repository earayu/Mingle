import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { renderManual } from "../src/core/manual.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** A line's work in a thread of its own, where the chat app has threads (docs/spec.md 4.13). */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const env = (t: ScriptedTurn) => t.options.env as Record<string, string>;
const isLine = (t: ScriptedTurn) => /[\\/]lines[\\/]/.test(String(t.options.cwd));
const fromOf = (input: string) => input.match(/\[task=t\w+ from=(m\w+)/)?.[1] as string;
const taskOf = (input: string) => input.match(/\[task=(t\w+)/)?.[1] as string;

describe("lines in threads", () => {
  it("opens a thread for the work, talks there, takes what is said there, and brings the result back", async () => {
    const front: string[] = [];
    const line: string[] = [];
    let task = "";
    let lineEnv: Record<string, string> | undefined;
    let acked = false;
    current = await rig(async (t) => {
      if (isLine(t)) {
        line.push(t.input);
        lineEnv = env(t);
        if (t.input.includes("[task=")) {
          task = taskOf(t.input);
          // After the acknowledgement, which opens the thread.
          await until(() => acked);
          await runCli(env(t), ["message", "send"], "Found it: the token is not refreshed.");
        } else if (t.input.includes("iOS too?")) {
          await runCli(env(t), ["message", "reply", fromOf(line[0] as string)], "Fixed on both: PR #12.");
          await runCli(env(t), ["task", "done", task], "Fixed the token refresh.");
        }
        return;
      }
      front.push(t.input);
      for (const id of messageIds(t.input)) {
        await runCli(env(t), ["task", "run", "Fix the login", "--from", id], "Open a PR.");
        await runCli(env(t), ["message", "reply", id], "On it, the progress is in the thread.");
        acked = true;
      }
    });
    const { mingle, channel, agentId } = current;
    channel.threads = true;

    const asked = channel.receive({ text: "@Alex Fix the login on Safari" });
    await until(() => task && channel.sent.some((m) => m.text.startsWith("Found it")));
    // The acknowledgement opened a thread under the message; the line spoke in it, not in the group.
    const ack = channel.sent.find((m) => m.text.startsWith("On it"));
    expect(ack?.inThread?.title).toBe("Fix the login");
    const thread = `-100:${asked.platformId}`;
    const found = channel.sent.find((m) => m.text.startsWith("Found it"));
    expect(found?.chat.platformId).toBe(thread);
    expect(found?.replyTo).toBeUndefined();
    const record = mingle.store.taskById(task);
    expect(record?.threadChat).toBeTruthy();
    expect(mingle.store.chat(record?.threadChat as string)?.parentId).toBe(record?.fromChat);
    expect(record?.progress).toBe("Found it: the token is not refreshed.");
    // The line was told where it talks.
    expect(line[0]).toMatch(/has a thread|opens a thread/);

    // Said in the thread without an @: it reaches the line, not the main session.
    await until(() => !mingle.runtime(agentId)?.busy);
    channel.receive({
      text: "iOS too?",
      addressedToBot: false,
      chat: { platformId: thread, kind: "thread", parent: { platformId: "-100" }, followUp: true },
    });
    await until(() => mingle.store.taskById(task)?.status === "done");
    expect(front.join("\n")).not.toContain("iOS too?");
    // The result goes to the chat itself, quoting the message, for everyone to see.
    const result = channel.sent.find((m) => m.text.startsWith("Fixed on both"));
    expect(result?.chat.platformId).toBe("-100");
    expect(result?.replyTo).toBe(asked.platformId);
    expect(result?.inChat).toBe(true);
    expect(lineEnv).toBeDefined();
  });

  it("opens the thread with the line's first word when the acknowledgement did not", async () => {
    let task = "";
    current = await rig(async (t) => {
      if (isLine(t)) {
        if (t.input.includes("[task=")) {
          task = taskOf(t.input);
          await runCli(env(t), ["message", "send"], "Starting: reading the logs.");
          await runCli(env(t), ["message", "send"], "Which browser version?");
        }
        return;
      }
      for (const id of messageIds(t.input)) await runCli(env(t), ["task", "run", "Look into it", "--from", id], "Go.");
    });
    const { mingle, channel } = current;
    channel.threads = true;
    const asked = channel.receive({ text: "@Alex look into the crash" });
    await until(() => channel.sent.some((m) => m.text === "Which browser version?"));
    const first = channel.sent.find((m) => m.text.startsWith("Starting"));
    expect(first?.chat.platformId).toBe("-100");
    expect(first?.replyTo).toBe(asked.platformId);
    expect(first?.inThread?.title).toBe("Look into it");
    const second = channel.sent.find((m) => m.text === "Which browser version?");
    expect(second?.chat.platformId).toBe(`-100:${asked.platformId}`);
    expect(second?.inThread).toBeUndefined();
    expect(mingle.store.taskById(task)?.progress).toBe("Which browser version?");
  });

  it("keeps to the chat where there are no threads, and the line reports how far it is to the console", async () => {
    let task = "";
    let brief = "";
    current = await rig(async (t) => {
      if (isLine(t)) {
        if (t.input.includes("[task=")) {
          task = taskOf(t.input);
          brief = t.input;
          await runCli(env(t), ["task", "status", "Reading the logs"]);
        }
        return;
      }
      for (const id of messageIds(t.input)) {
        const run = await runCli(env(t), ["task", "run", "Look into it", "--from", id], "Go.");
        expect(run.stdout).not.toContain("thread");
        await runCli(env(t), ["message", "reply", id], "On it.");
      }
    });
    const { mingle, channel } = current;
    const asked = channel.receive({ text: "@Alex look into the crash" });
    await until(
      () =>
        task &&
        mingle.store.taskById(task)?.progress === "Reading the logs" &&
        channel.sent.some((m) => m.text === "On it."),
    );
    expect(brief).toContain("no threads");
    const ack = channel.sent.find((m) => m.text === "On it.");
    // No thread here: a plain quoted reply, as before.
    expect(ack?.replyTo).toBe(asked.platformId);
    expect(mingle.store.taskById(task)?.threadChat).toBeNull();
  });

  it("works in the thread a message was already in, and the result also shows in the chat", async () => {
    let task = "";
    current = await rig(async (t) => {
      if (isLine(t)) {
        if (t.input.includes("[task=")) {
          task = taskOf(t.input);
          await runCli(env(t), ["message", "send"], "Looking.");
          await runCli(env(t), ["message", "reply", fromOf(t.input)], "Done: PR #3.");
        }
        return;
      }
      for (const id of messageIds(t.input)) await runCli(env(t), ["task", "run", "Do it", "--from", id], "Go.");
    });
    const { mingle, channel } = current;
    channel.threads = true;
    const chat = { platformId: "C1:171", kind: "thread" as const, parent: { platformId: "C1" } };
    const asked = channel.receive({ text: "@Alex do the thing", chat });
    await until(() => channel.sent.some((m) => m.text === "Done: PR #3."));
    const record = mingle.store.taskById(task);
    expect(record?.threadChat).toBe(record?.fromChat);
    const looking = channel.sent.find((m) => m.text === "Looking.");
    expect(looking?.chat.platformId).toBe("C1:171");
    expect(looking?.inThread).toBeUndefined();
    const done = channel.sent.find((m) => m.text === "Done: PR #3.");
    expect(done?.replyTo).toBe(asked.platformId);
    expect(done?.inChat).toBe(true);
  });

  it("lets a line close its own task when told to stop, and nothing else", async () => {
    let task = "";
    let lineEnv: Record<string, string> | undefined;
    let closed: { code: number; stdout: string; stderr: string } | undefined;
    current = await rig(async (t) => {
      if (isLine(t)) {
        lineEnv = env(t);
        if (t.input.includes("[task=")) task = taskOf(t.input);
        else if (t.input.includes("stop")) {
          await runCli(env(t), ["message", "send"], "Stopping. I had found the cause, nothing changed yet.");
          closed = await runCli(env(t), ["task", "update", task, "--status", "closed"]);
        }
        return;
      }
      for (const id of messageIds(t.input)) {
        if (t.input.includes("crash")) await runCli(env(t), ["task", "run", "Look into it", "--from", id], "Go.");
      }
    });
    const { mingle, channel, agentId } = current;
    channel.threads = true;
    const asked = channel.receive({ text: "@Alex look into the crash" });
    await until(() => task && mingle.store.taskById(task)?.lineState === "idle");
    const asLine = lineEnv as Record<string, string>;
    // Not another status, not another task.
    const done = await runCli(asLine, ["task", "update", task, "--status", "done"]);
    expect(done.stderr + done.stdout).toContain("line_out_of_scope");
    const other = await runCli(asLine, ["task", "run", "More", "--from", "m1"], "x");
    expect(other.stderr + other.stdout).toContain("line_out_of_scope");

    channel.receive({ text: "please stop", replyTo: asked.platformId });
    await until(() => closed);
    expect(closed?.code).toBe(0);
    await until(() => mingle.store.taskById(task)?.lineState === "ended");
    expect(mingle.store.taskById(task)?.status).toBe("closed");
    // The main session hears of it with its next input.
    expect(
      mingle.store
        .ownerNotes(agentId)
        .map((n) => n.body)
        .join("\n"),
    ).toContain(`Task ${task}`);
  });

  it("takes a reply in a new thread under the agent's message as addressed to it", async () => {
    const front: string[] = [];
    current = await rig(async (t) => {
      front.push(t.input);
      for (const id of messageIds(t.input)) {
        if (t.input.includes("weather")) await runCli(env(t), ["message", "reply", id], "Sunny on Saturday.");
      }
    });
    const { agentId, channel, mingle } = current;
    channel.threads = true;
    channel.receive({ text: "@Alex weather on Saturday?" });
    const answer = await until(() => channel.sent.find((m) => m.text === "Sunny on Saturday."));
    // Wait for the turn to finish: a follow-up sent mid-turn is steered into the
    // running session, while this test checks thread routing of a new message.
    await until(() => !mingle.runtime(agentId)?.busy);
    // "Reply in thread" on the agent's answer: a thread chat of its own, quoting a message in the group.
    channel.receive({
      text: "And Sunday?",
      addressedToBot: false,
      replyTo: answer.platformId,
      chat: {
        platformId: `-100:${answer.platformId}`,
        kind: "thread",
        parent: { platformId: "-100" },
        followUp: true,
      },
    });
    await until(() => front.some((input) => input.includes("And Sunday?")));
  });

  it("opens a thread even when a live reply is open for the message, and settles the live reply", async () => {
    let task = "";
    let acked = false;
    current = await rig(
      async (t) => {
        if (isLine(t)) {
          if (t.input.includes("[task=")) {
            task = taskOf(t.input);
            await until(() => acked);
            await runCli(env(t), ["message", "send"], "Working in the thread.");
            await runCli(env(t), ["message", "reply", fromOf(t.input)], "All done.");
            await runCli(env(t), ["task", "done", task], "Finished.");
          }
          return;
        }
        for (const id of messageIds(t.input)) {
          await runCli(env(t), ["task", "run", "Fix bug", "--from", id], "Go.");
          await runCli(env(t), ["message", "reply", id], "On it, progress in the thread.");
          acked = true;
        }
      },
      { live: true },
    );
    const { mingle, channel } = current;
    channel.threads = true;

    const asked = channel.receive({ text: "@Alex Fix the bug" });
    await until(() => task && mingle.store.taskById(task)?.status === "done");

    // The acknowledgement went through send({ inThread }), not into the live reply, so the thread opened.
    const ack = channel.sent.find((m) => m.text === "On it, progress in the thread.");
    expect(ack?.inThread?.title).toBe("Fix bug");
    const thread = `-100:${asked.platformId}`;
    expect(mingle.store.taskById(task)?.threadChat).toBeTruthy();
    expect(channel.sent.find((m) => m.text === "Working in the thread.")?.chat.platformId).toBe(thread);
    expect(channel.sent.find((m) => m.text === "All done.")?.inChat).toBe(true);
    // The live reply opened for the ask was settled instead of left stuck on progress.
    await until(() => channel.lives[0]?.final !== undefined);
    expect(channel.lives[0]?.final).not.toBe("On it, progress in the thread.");
  });

  it("guides a line to talk in its thread at a few moments, report where there is none, and stop when told", () => {
    const line = renderManual("Alex", "", "darwin", [], { taskId: "t9", title: "Fix login", home: "/h/alex" });
    expect(line).toContain("when you start, when you need to ask someone, when the direction changes");
    expect(line).toContain("task status");
    expect(line).toContain("task update t9 --status closed");
  });
});
