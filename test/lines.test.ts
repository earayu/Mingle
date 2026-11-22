import { join } from "node:path";
import type { Runtime, Session } from "@botiverse/oar";
import { type ScriptedTurn, scriptedRuntime } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { Lines, MAX_LINES } from "../src/core/lines.ts";
import { renderManual } from "../src/core/manual.ts";
import { type Harness, type HarnessEvents, oarHarness } from "../src/harness/harness.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** Several things at once (docs/spec.md 4.13): lines beside the main session. */

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const env = (t: ScriptedTurn) => t.options.env as Record<string, string>;
// Either separator: the line's directory is a Windows path there.
const isLine = (t: ScriptedTurn) => /[\\/]lines[\\/]/.test(String(t.options.cwd));
/** The message a line's brief says it is for. */
const fromOf = (input: string) => input.match(/\[task=t\w+ from=(m\w+)/)?.[1] as string;
const taskOf = (input: string) => input.match(/\[task=(t\w+)/)?.[1] as string;

describe("lines", () => {
  it("works on a long task beside the main session, answers in the chat, and takes follow-ups", async () => {
    const front: string[] = [];
    const line: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let task = "";
    current = await rig(async (t) => {
      if (isLine(t)) {
        line.push(t.input);
        if (t.input.includes("[task=")) {
          task = taskOf(t.input);
          // Busy for a while: the main session must stay free meanwhile.
          await gate;
          await runCli(env(t), ["message", "reply", fromOf(t.input)], "Fixed: PR #12.");
          await runCli(env(t), ["task", "done", task], "Fixed the token refresh. PR #12. Learned: run pnpm test:web.");
        } else {
          const id = messageIds(t.input)[0] as string;
          await runCli(env(t), ["message", "reply", id], "Signup is fixed too.");
        }
        return;
      }
      front.push(t.input);
      for (const id of messageIds(t.input)) {
        if (t.input.includes("Fix the login")) {
          await runCli(env(t), ["task", "run", "Fix the login", "--from", id], "Safari only. Open a PR.");
          await runCli(env(t), ["message", "reply", id], "On it.");
        } else await runCli(env(t), ["message", "reply", id], "10:30.");
      }
    });
    const { mingle, channel, agentId } = current;

    channel.receive({ text: "@Alex Fix the login on Safari" });
    await until(() => task && channel.sent.some((m) => m.text === "On it.") && !mingle.runtime(agentId)?.busy);
    // While the line works, the main session answers something else at once.
    channel.receive({ text: "@Alex when is the meeting?" });
    await until(() => channel.sent.some((m) => m.text === "10:30."));
    expect(line).toHaveLength(1);
    release();

    // The line answers under the message it came from, as the agent.
    await until(() => channel.sent.some((m) => m.text === "Fixed: PR #12."));
    const fixed = channel.sent.find((m) => m.text === "Fixed: PR #12.");
    const asked = channel.sent.find((m) => m.text === "On it.");
    expect(fixed?.replyTo).toBe(asked?.replyTo);
    await until(() => mingle.store.task(agentId, task)?.status === "done");
    expect(line[0]).toContain("Safari only. Open a PR.");

    // A reply to the line's answer goes to the line, not the main session.
    channel.receive({ text: "Can you look at signup too?", replyTo: fixed?.platformId as string });
    await until(() => channel.sent.some((m) => m.text === "Signup is fixed too."));
    expect(line.at(-1)).toContain("Can you look at signup too?");
    expect(front.join("\n")).not.toContain("Can you look at signup too?");
    expect(mingle.store.task(agentId, task)?.status).toBe("in_progress");

    // The summary reaches the main session with its next input, not as a turn of its own.
    const turns = front.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(front).toHaveLength(turns);
    await until(() => !mingle.runtime(agentId)?.busy);
    channel.receive({ text: "@Alex thanks" });
    await until(() => front.length > turns);
    expect(front.at(-1)).toContain("Learned: run pnpm test:web.");
    // Nothing was left unanswered or nudged.
    expect(front.join("\n")).not.toContain("Not answered yet");
  });

  it("keeps a line to its task, and only lines finish tasks", async () => {
    let lineEnv: Record<string, string> | undefined;
    let frontEnv: Record<string, string> | undefined;
    current = await rig(async (t) => {
      if (isLine(t)) {
        lineEnv = env(t);
        return;
      }
      frontEnv = env(t);
      const id = messageIds(t.input)[0];
      if (id && t.input.includes("work")) await runCli(env(t), ["task", "run", "Work", "--from", id], "Do it.");
    });
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex some work", chat: { platformId: "-200", kind: "group", name: "Other" } });
    const asLine = await until(() => lineEnv);
    const asFront = await until(() => frontEnv);
    await until(() => !mingle.runtime(agentId)?.busy);
    channel.receive({ text: "@Alex hello" });
    const elsewhere = await until(
      () =>
        mingle.store.agentConversations(agentId, { chats: 5, messages: 5 }).find((c) => c.chat.name === "Weekend hikes")
          ?.messages[0]?.id,
    );

    const reply = await runCli(asLine, ["message", "reply", elsewhere], "hi");
    expect(reply.code).not.toBe(0);
    expect(reply.stderr + reply.stdout).toContain("line_out_of_scope");
    const remind = await runCli(asLine, ["reminder", "set", "x", "--in", "1h", "--chat", "c1"]);
    expect(remind.stderr + remind.stdout).toContain("line_out_of_scope");
    const nested = await runCli(asLine, ["task", "run", "More", "--from", elsewhere], "x");
    expect(nested.stderr + nested.stdout).toContain("line_out_of_scope");
    const me = await runCli(asLine, ["whoami"]);
    expect(me.stdout).toContain("this session works on t");
    const done = await runCli(asFront, ["task", "done", "t1"], "x");
    expect(done.stderr + done.stdout).toContain("line_only");
  });

  it("runs at most three lines at once and starts the next when one is free", async () => {
    const gates: (() => void)[] = [];
    let running = 0;
    let most = 0;
    current = await rig(async (t) => {
      if (isLine(t)) {
        running++;
        most = Math.max(most, running);
        await new Promise<void>((r) => gates.push(r));
        running--;
        await runCli(env(t), ["task", "done", taskOf(t.input)], "done");
        return;
      }
      for (const id of messageIds(t.input)) await runCli(env(t), ["task", "run", `Job ${id}`, "--from", id], "go");
    });
    const { channel, mingle, agentId } = current;
    for (let i = 0; i < MAX_LINES + 1; i++) {
      channel.receive({ text: `@Alex job ${i}`, chat: { platformId: `-3${i}`, kind: "group", name: `G${i}` } });
    }
    // The main session may start the fourth in a later turn than the first three.
    await until(() => gates.length === MAX_LINES && mingle.store.activeLines(agentId).length === MAX_LINES + 1);
    await new Promise((r) => setTimeout(r, 200));
    expect(gates).toHaveLength(MAX_LINES);
    expect(mingle.store.activeLines(agentId).filter((t) => t.lineState === "queued")).toHaveLength(1);
    gates.shift()?.();
    await until(() => gates.length === MAX_LINES);
    // The fourth started once one finished; let the rest go.
    expect(mingle.store.activeLines(agentId).filter((t) => t.lineState === "queued")).toHaveLength(0);
    for (const open of gates.splice(0)) open();
    await until(() => mingle.store.activeLines(agentId).length === 0);
    expect(most).toBe(MAX_LINES);
  });

  it("stops every line with /stop, one from the console, and carries on after a restart", async () => {
    let started = 0;
    current = await rig(async (t) => {
      if (isLine(t)) {
        started++;
        await new Promise(() => {}); // works until stopped
        return;
      }
      const id = messageIds(t.input)[0];
      if (id && t.input.includes("job")) await runCli(env(t), ["task", "run", "Job", "--from", id], "go");
    });
    const { channel, mingle, agentId, admin } = current;
    channel.receive({ text: "@Alex job" });
    await until(() => started === 1);
    const task = mingle.store.activeLines(agentId)[0]?.id as string;
    expect(await mingle.stopAgent(agentId)).toBe(true);
    await until(() => mingle.store.task(agentId, task)?.lineState === "idle");
    // Still in progress: the next message about it wakes it again.
    expect(mingle.store.task(agentId, task)?.status).toBe("in_progress");

    mingle.lines.wake(task, "go on");
    await until(() => started === 2);
    // Work under way when Mingle stops (here: its sessions let go) carries on when it starts again.
    await mingle.lines.suspend(agentId);
    expect(mingle.store.task(agentId, task)?.lineState).toBe("running");
    mingle.lines.restore(agentId);
    await until(() => started === 3);
    await admin("POST", `/v1/admin/agents/${agentId}/tasks/${task}/close`);
    await until(() => mingle.store.task(agentId, task)?.lineState === "ended");
    expect(mingle.store.task(agentId, task)?.status).toBe("closed");
  });

  it("brings the conversation to a line, starts one line per message, and stops it when the task is closed", async () => {
    let started = 0;
    let brief = "";
    let frontEnv: Record<string, string> | undefined;
    let from = "";
    current = await rig(async (t) => {
      if (isLine(t)) {
        started++;
        if (!brief) brief = t.input;
        await new Promise(() => {}); // works until stopped
        return;
      }
      frontEnv = env(t);
      const id = messageIds(t.input).at(-1);
      if (id && t.input.includes("migrate")) {
        from = id;
        await runCli(env(t), ["task", "run", "Migrate", "--from", id], "Move the table.");
      }
    });
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "The orders table is the one in Postgres, not MySQL" });
    channel.receive({ text: "@Alex migrate it please" });
    await until(() => started === 1 && brief);
    // The brief carries the message itself and what came before it, not only their IDs.
    expect(brief).toContain("Move the table.");
    expect(brief).toContain("migrate it please");
    expect(brief).toContain("the one in Postgres, not MySQL");
    expect(brief).toContain(`--around ${from}`);

    // A second line for the same message is refused: the follow-up goes to the first.
    const again = await runCli(frontEnv as Record<string, string>, ["task", "run", "Migrate", "--from", from], "x");
    expect(again.code).not.toBe(0);
    expect(again.stderr + again.stdout).toContain("already_running");
    expect(mingle.store.activeLines(agentId)).toHaveLength(1);

    // "Drop it": the main session closes the task, and the line stops at once.
    const task = mingle.store.activeLines(agentId)[0]?.id as string;
    const closed = await runCli(frontEnv as Record<string, string>, ["task", "update", task, "--status", "closed"]);
    expect(closed.code).toBe(0);
    await until(() => mingle.store.task(agentId, task)?.lineState === "ended");
    expect(mingle.store.task(agentId, task)?.status).toBe("closed");
    // Once closed, the same message may start a line again.
    const restart = await runCli(frontEnv as Record<string, string>, ["task", "run", "Migrate", "--from", from], "x");
    expect(restart.code).toBe(0);
  });

  it("keeps a follow-up that waits for a free line across a restart", async () => {
    const quickInputs: string[] = [];
    let runs = 0;
    current = await rig(async (t) => {
      if (isLine(t)) {
        if (/\] quick\n/.test(t.input) || t.input.includes("FOLLOWUP")) quickInputs.push(t.input);
        if (/\] quick\n/.test(t.input) && !t.input.includes("reported last time")) {
          await runCli(env(t), ["message", "reply", fromOf(t.input)], "Quick done.");
          await runCli(env(t), ["task", "done", taskOf(t.input)], "ok");
        } else if (t.input.includes("[task=") && !t.input.includes("FOLLOWUP")) {
          await new Promise(() => {}); // busy until stopped
        }
        return;
      }
      for (const id of messageIds(t.input))
        await runCli(env(t), ["task", "run", runs++ === 0 ? "quick" : "slow", "--from", id], "go");
    });
    const { channel, mingle, agentId } = current;
    const group = (n: string) => ({ platformId: `-7${n}`, kind: "group" as const, name: `G${n}` });
    channel.receive({ text: "@Alex quick", chat: group("q") });
    await until(() => channel.sent.some((m) => m.text === "Quick done."));
    await until(() => mingle.store.activeLines(agentId).length === 0);
    for (let i = 0; i < MAX_LINES; i++) channel.receive({ text: `@Alex slow ${i}`, chat: group(String(i)) });
    await until(() => mingle.store.activeLines(agentId).filter((t) => t.lineState === "running").length === MAX_LINES);

    // A follow-up to the finished work waits: every line is busy.
    const quick = channel.sent.find((m) => m.text === "Quick done.");
    channel.receive({ text: "FOLLOWUP: signup too", replyTo: quick?.platformId as string, chat: group("q") });
    await until(() => mingle.store.activeLines(agentId).some((t) => t.lineState === "queued"));

    // Mingle stops and starts again before a line is free; the follow-up must not be lost.
    await mingle.lines.suspend(agentId);
    mingle.lines.restore(agentId);
    const slow = mingle.store.activeLines(agentId).find((t) => t.title === "slow");
    await mingle.lines.end(slow?.id as string);
    await until(() => quickInputs.some((i) => i.includes("FOLLOWUP: signup too")));
    expect(quickInputs.filter((i) => i.includes("FOLLOWUP: signup too"))).toHaveLength(1);
  });

  it("does not leave a line working when the harness refuses its next input", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex hi" });
    await until(() => mingle.store.agentChats(agentId).length > 0);
    const chat = mingle.store.agentChats(agentId)[0];
    const from = mingle.store.chatMessages(chat?.id as string, 1)[0]?.id as string;
    let events: HarnessEvents | undefined;
    let delivered = 0;
    const harness = {
      open: async (_options: unknown, e: HarnessEvents) => {
        events = e;
        return {
          id: "s1",
          resumed: false,
          deliver: async () => {
            delivered++;
            // The first input starts a turn; the harness refuses everything after it.
            return delivered === 1
              ? { outcome: "prompted" as const }
              : { outcome: "rejected" as const, reason: "closed" };
          },
          abort: async () => false,
          dispose: async () => {},
        };
      },
    } as unknown as Harness;
    const lines = new Lines({
      store: mingle.store,
      harness,
      dir: () => join(current?.home as string, "lines-unit"),
      manual: () => "",
      env: () => ({}),
      agentEnv: () => undefined,
      note: () => {},
      unanswered: () => [],
      paused: () => false,
    });
    const task = mingle.store.createLineTask({
      agentId,
      title: "Job",
      fromMessage: from,
      fromChat: chat?.id as string,
      brief: "go",
    });
    lines.start(task);
    await until(() => delivered === 1);
    // Handed something mid-turn and refused: it waits for the next turn, which is refused too.
    lines.wake(task.id, "more");
    await until(() => delivered === 2);
    events?.onTurnEnded({ kind: "completed" });
    await until(() => mingle.store.taskById(task.id)?.lineState === "error");
    expect(delivered).toBe(3);
    await lines.close();
  });

  it("keeps a line's session open while its background work runs, so the harness can wake it", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex hi" });
    await until(() => mingle.store.agentChats(agentId).length > 0);
    const chat = mingle.store.agentChats(agentId)[0];
    const from = mingle.store.chatMessages(chat?.id as string, 1)[0]?.id as string;
    let events: HarnessEvents | undefined;
    let background = 0;
    let disposed = 0;
    const inputs: string[] = [];
    const harness = {
      open: async (_options: unknown, e: HarnessEvents) => {
        events = e;
        return {
          id: "s1",
          resumed: false,
          deliver: async (text: string) => {
            inputs.push(text);
            e.onTurnStarted();
            return { outcome: "prompted" as const };
          },
          background: () => background,
          abort: async () => false,
          dispose: async () => {
            disposed++;
          },
        };
      },
    } as unknown as Harness;
    const lines = new Lines({
      store: mingle.store,
      harness,
      dir: () => join(current?.home as string, "lines-unit"),
      manual: () => "",
      env: () => ({}),
      agentEnv: () => undefined,
      note: () => {},
      unanswered: () => [],
      paused: () => false,
      settleMs: 100,
    });
    const task = mingle.store.createLineTask({
      agentId,
      title: "Job",
      fromMessage: from,
      fromChat: chat?.id as string,
      brief: "go",
    });
    lines.start(task);
    await until(() => inputs.length === 1);
    // The turn ends with a command still running in the background (a long sleep, a build).
    background = 1;
    events?.onTurnEnded({ kind: "completed" });
    await new Promise((r) => setTimeout(r, 300));
    expect(disposed).toBe(0);
    expect(mingle.store.taskById(task.id)?.lineState).toBe("running");
    // A follow-up meanwhile goes straight into the open session.
    lines.wake(task.id, "how is it going?");
    await until(() => inputs.length === 2);
    events?.onTurnEnded({ kind: "completed" });
    // The command ends and the harness begins a turn of its own; the line answers and rests.
    background = 0;
    events?.onTurnStarted(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(disposed).toBe(0);
    events?.onTurnEnded({ kind: "completed" });
    await until(() => mingle.store.taskById(task.id)?.lineState === "idle");
    expect(disposed).toBe(1);
    expect(mingle.store.taskById(task.id)?.status).toBe("in_progress");
    await lines.close();
  });

  it("closes a line whose background work ended without the harness waking it", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex hi" });
    await until(() => mingle.store.agentChats(agentId).length > 0);
    const chat = mingle.store.agentChats(agentId)[0];
    const from = mingle.store.chatMessages(chat?.id as string, 1)[0]?.id as string;
    let events: HarnessEvents | undefined;
    let background = 1;
    let disposed = 0;
    const harness = {
      open: async (_options: unknown, e: HarnessEvents) => {
        events = e;
        return {
          id: "s1",
          resumed: false,
          deliver: async () => {
            e.onTurnStarted();
            return { outcome: "prompted" as const };
          },
          background: () => background,
          abort: async () => false,
          dispose: async () => {
            disposed++;
          },
        };
      },
    } as unknown as Harness;
    const lines = new Lines({
      store: mingle.store,
      harness,
      dir: () => join(current?.home as string, "lines-unit"),
      manual: () => "",
      env: () => ({}),
      agentEnv: () => undefined,
      note: () => {},
      unanswered: () => [],
      paused: () => false,
      settleMs: 100,
    });
    const task = mingle.store.createLineTask({
      agentId,
      title: "Job",
      fromMessage: from,
      fromChat: chat?.id as string,
      brief: "go",
    });
    lines.start(task);
    await until(() => events);
    events?.onTurnEnded({ kind: "completed" });
    await new Promise((r) => setTimeout(r, 200));
    expect(disposed).toBe(0);
    background = 0;
    await until(() => mingle.store.taskById(task.id)?.lineState === "idle");
    expect(disposed).toBe(1);
    await lines.close();
  });

  it("keeps a line open across slow TTFT when turn_active follows background work completion (MING-140)", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex hi" });
    await until(() => mingle.store.agentChats(agentId).length > 0);
    const chat = mingle.store.agentChats(agentId)[0];
    const from = mingle.store.chatMessages(chat?.id as string, 1)[0]?.id as string;
    let emit: (event: Record<string, unknown>) => void = () => {};
    let disposed = 0;
    let delivered = 0;
    const rawSession = {
      id: "s-bg",
      events: (observer: (event: Record<string, unknown>) => void) => {
        emit = (event) => observer({ agentPath: [], ...event });
        return () => {};
      },
      deliver: async () => {
        delivered++;
        emit({ kind: "turn_started" });
        return { landed: "prompted" as const };
      },
      abort: async () => ({ kind: "accepted" as const }),
      dispose: async () => {
        disposed++;
      },
    } as unknown as Session;
    const runtime = {
      ...scriptedRuntime({ id: "pi", turn: () => {} }),
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: async () => rawSession,
    } as unknown as Runtime;
    const lines = new Lines({
      store: mingle.store,
      harness: oarHarness({ require: () => runtime }),
      dir: () => join(current?.home as string, "lines-ttft"),
      manual: () => "",
      env: () => ({}),
      agentEnv: () => undefined,
      note: () => {},
      unanswered: () => [],
      paused: () => false,
      settleMs: 100,
    });
    const task = mingle.store.createLineTask({
      agentId,
      title: "Render video",
      fromMessage: from,
      fromChat: chat?.id as string,
      brief: "render",
    });
    lines.start(task);
    await until(() => delivered === 1);
    // Turn 1 moves a long command into the background and ends.
    emit({ kind: "task_started", taskId: "bg1", taskType: "shell", background: true });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    // Background command finishes: background() drops to 0 and Claude emits system/init -> turn_active
    // before the model starts returning tokens.
    emit({ kind: "task_updated", taskId: "bg1", status: "completed" });
    emit({ kind: "task_ended", taskId: "bg1", status: "completed" });
    emit({ kind: "turn_active" });
    // Wait well past settleMs with no model tokens yet (slow TTFT): the session must NOT be disposed.
    await new Promise((r) => setTimeout(r, 300));
    expect(disposed).toBe(0);
    expect(mingle.store.taskById(task.id)?.lineState).toBe("running");
    // Model finally replies and completes the turn: now the line rests cleanly.
    emit({ kind: "text_delta" });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    await until(() => mingle.store.taskById(task.id)?.lineState === "idle");
    expect(disposed).toBe(1);
    await lines.close();
  });

  it("marks a line errored and notifies the main session if its harness exits unexpectedly", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex hi" });
    await until(() => mingle.store.agentChats(agentId).length > 0);
    const chat = mingle.store.agentChats(agentId)[0];
    const from = mingle.store.chatMessages(chat?.id as string, 1)[0]?.id as string;
    let emit: (event: Record<string, unknown>) => void = () => {};
    let delivered = 0;
    const notes: string[] = [];
    const rawSession = {
      id: "s-crash",
      events: (observer: (event: Record<string, unknown>) => void) => {
        emit = (event) => observer({ agentPath: [], ...event });
        return () => {};
      },
      deliver: async () => {
        delivered++;
        emit({ kind: "turn_started" });
        return { landed: "prompted" as const };
      },
      abort: async () => ({ kind: "accepted" as const }),
      dispose: async () => {},
    } as unknown as Session;
    const runtime = {
      ...scriptedRuntime({ id: "pi", turn: () => {} }),
      installation: async () => ({ kind: "available", via: "bundled" }),
      session: async () => rawSession,
    } as unknown as Runtime;
    const lines = new Lines({
      store: mingle.store,
      harness: oarHarness({ require: () => runtime }),
      dir: () => join(current?.home as string, "lines-crash"),
      manual: () => "",
      env: () => ({}),
      agentEnv: () => undefined,
      note: (_id, body) => notes.push(body),
      unanswered: () => [],
      paused: () => false,
      settleMs: 100,
    });
    const task = mingle.store.createLineTask({
      agentId,
      title: "Job",
      fromMessage: from,
      fromChat: chat?.id as string,
      brief: "go",
    });
    lines.start(task);
    await until(() => delivered === 1);
    emit({ kind: "task_started", taskId: "bg1", taskType: "shell", background: true });
    emit({ kind: "turn_ended", outcome: { kind: "completed" } });
    // Harness crashes while background work is still running.
    emit({ kind: "exited", code: 1 });
    await until(() => mingle.store.taskById(task.id)?.lineState === "error");
    expect(mingle.store.taskById(task.id)?.lineError).toContain("exited");
    expect(notes.some((n) => n.includes(task.id))).toBe(true);
    await lines.close();
  });

  it("does not clobber a newly woken run to idle when the previous session finishes disposing", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex hi" });
    await until(() => mingle.store.agentChats(agentId).length > 0);
    const chat = mingle.store.agentChats(agentId)[0];
    const from = mingle.store.chatMessages(chat?.id as string, 1)[0]?.id as string;
    const disposeGate = Promise.withResolvers<void>();
    const delivered: string[] = [];
    let events: HarnessEvents | undefined;
    let opens = 0;
    const harness = {
      open: async (_options: unknown, e: HarnessEvents) => {
        const n = ++opens;
        events = e;
        return {
          id: `s${n}`,
          resumed: n > 1,
          deliver: async (input: string) => {
            delivered.push(input);
            e.onTurnStarted();
            return { outcome: "prompted" as const };
          },
          abort: async () => false,
          dispose: async () => {
            if (n === 1) await disposeGate.promise;
          },
        };
      },
    } as unknown as Harness;
    const lines = new Lines({
      store: mingle.store,
      harness,
      dir: () => join(current?.home as string, "lines-race"),
      manual: () => "",
      env: () => ({}),
      agentEnv: () => undefined,
      note: () => {},
      unanswered: () => [],
      paused: () => false,
    });
    const task = mingle.store.createLineTask({
      agentId,
      title: "Job",
      fromMessage: from,
      fromChat: chat?.id as string,
      brief: "go",
    });
    lines.start(task);
    await until(() => delivered.length === 1);
    // Turn 1 ends -> rest() enters letGo(), which blocks on s1.dispose().
    events?.onTurnEnded({ kind: "completed" });
    // A follow-up arrives while s1.dispose() is still in flight, starting run 2.
    lines.wake(task.id, "follow-up");
    await until(() => delivered.length === 2);
    expect(mingle.store.taskById(task.id)?.lineState).toBe("running");
    // Now s1.dispose() finishes: rest() must NOT overwrite run 2's lineState to idle.
    disposeGate.resolve();
    await new Promise((r) => setTimeout(r, 30));
    expect(mingle.store.taskById(task.id)?.lineState).toBe("running");
    events?.onTurnEnded({ kind: "completed" });
    await until(() => mingle.store.taskById(task.id)?.lineState === "idle");
    await lines.close();
  });

  it("delivers a rejected steered follow-up once on the next turn, not twice", async () => {
    current = await rig(async () => {});
    const { channel, mingle, agentId } = current;
    channel.receive({ text: "@Alex hi" });
    await until(() => mingle.store.agentChats(agentId).length > 0);
    const chat = mingle.store.agentChats(agentId)[0];
    const from = mingle.store.chatMessages(chat?.id as string, 1)[0]?.id as string;
    const follow = mingle.store.insertInbound({
      chatId: chat?.id as string,
      platformId: "p-follow",
      senderId: "u1",
      senderName: "Alice",
      body: "also check safari",
      attachments: [],
      replyTo: from,
      triggers: true,
      createdAt: Date.now(),
    });
    expect(follow).toBeDefined();
    mingle.store.moveInbound([follow?.id as string], "deliver");
    const delivered: string[] = [];
    let rejectedOnce = false;
    let events: HarnessEvents | undefined;
    const harness = {
      open: async (_options: unknown, e: HarnessEvents) => {
        events = e;
        return {
          id: "s1",
          resumed: false,
          deliver: async (input: string) => {
            if (!rejectedOnce && input.includes("also check safari")) {
              rejectedOnce = true;
              return { outcome: "rejected" as const, reason: "turn ending" };
            }
            delivered.push(input);
            e.onTurnStarted();
            return { outcome: "prompted" as const };
          },
          abort: async () => false,
          dispose: async () => {},
        };
      },
    } as unknown as Harness;
    const lines = new Lines({
      store: mingle.store,
      harness,
      dir: () => join(current?.home as string, "lines-steer"),
      manual: () => "",
      env: () => ({}),
      agentEnv: () => undefined,
      note: () => {},
      unanswered: () => [],
      paused: () => false,
    });
    const task = mingle.store.createLineTask({
      agentId,
      title: "Job",
      fromMessage: from,
      fromChat: chat?.id as string,
      brief: "go",
    });
    lines.start(task);
    await until(() => delivered.length === 1);
    lines.wake(task.id, "also check safari", follow?.id);
    // Let the rejected promise settle before ending turn 1.
    await new Promise((r) => setTimeout(r, 20));
    events?.onTurnEnded({ kind: "completed" });
    await until(() => delivered.length === 2);
    expect(delivered[1]).toBe("also check safari");
    events?.onTurnEnded({ kind: "completed" });
    await until(() => mingle.store.taskById(task.id)?.lineState === "idle");
    await lines.close();
  });

  it("guides the main session to hand off long work, and a line to stay on its task", () => {
    const main = renderManual("Alex", "", "darwin");
    expect(main).toContain("## Doing long work");
    expect(main).toContain("task run");
    const line = renderManual("Alex", "", "darwin", [], { taskId: "t9", title: "Fix login", home: "/h/alex" });
    expect(line).toContain('works on one task: t9, "Fix login"');
    expect(line).toContain("task done t9");
    expect(line).toContain("You are still Alex");
  });
});
