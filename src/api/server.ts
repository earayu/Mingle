import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import QRCode from "qrcode";
import type { CredentialField, OnboardingMethod, PermissionId, Platform, Trust } from "../channels/channel.ts";
import { CHECK_MIN_INTERVAL_MS, checkCommand, checkUntil } from "../core/check.ts";
import { sendTarget } from "../core/direct.ts";
import { contactAlias, MingleError, notFound } from "../core/errors.ts";
import { excerpt, renderMessage } from "../core/format.ts";
import { readRole } from "../core/home.ts";
import { renderManual } from "../core/manual.ts";
import { AVATAR_MAX_BYTES, type Mingle } from "../core/mingle.ts";
import * as people from "../core/people.ts";
import { nextFire, parseDuration } from "../core/schedule.ts";
import type { HarnessInfo } from "../harness/harness.ts";
import { readSshConfig } from "../platform/ssh-config.ts";
import {
  type Agent,
  type Chat,
  type Connection,
  type Contact,
  contactName,
  type Handoff,
  type HearPace,
  type Message,
  type Task,
  type TaskStatus,
} from "../store/store.ts";
import { VERSION } from "../version.ts";
import { remoteGateway, remoteResponse } from "./remote.ts";

/** `line`: the task a line's token is scoped to (docs/spec.md 4.13); absent for the main session. */
type Env = { Variables: { agent: Agent; line: string | undefined } };

const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "closed"];

/** What a line may write (docs/spec.md 4.13): answer about its task, fetch files, report, finish or stop it. */
const LINE_WRITES: readonly (readonly [string, RegExp])[] = [
  ["POST", /^\/v1\/agent\/messages\/(reply|send)$/],
  ["POST", /^\/v1\/agent\/files\/[^/]+\/download$/],
  ["POST", /^\/v1\/agent\/tasks\/[^/]+\/done$/],
  ["POST", /^\/v1\/agent\/tasks\/progress$/],
  // Only to close its own task, when someone says to stop (checked in the route).
  ["PATCH", /^\/v1\/agent\/tasks\/[^/]+$/],
];

/**
 * The local API. Two kinds of caller:
 * - /v1/agent/*: the `mingle` CLI run by an agent, authenticated by its per-launch token.
 * - /v1/admin/*: the owner (CLI or console), authenticated by the admin token in runtime.json.
 */
export function createApi(mingle: Mingle): Hono<Env> {
  const app = new Hono<Env>();
  const { store } = mingle;

  app.onError((error, c) => {
    if (error instanceof MingleError) {
      return c.json({ error: error.code, next: error.next }, error.status as 400);
    }
    // c.req.json() throws a SyntaxError on a malformed body: the caller's fault, not a bug.
    if (error instanceof SyntaxError) {
      return c.json({ error: "invalid_json", next: "the request body is not valid JSON" }, 400);
    }
    mingle.log(`api: ${error.stack ?? error.message}`);
    return c.json({ error: "internal", next: "this is a Mingle bug; check ~/.mingle/logs" }, 500);
  });

  app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION }));

  app.get("/v1/ssh-avatars/:host/:file", async (c) => {
    const file = c.req.param("file");
    if (!/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(file)) return c.body(null, 404);
    return remoteResponse(
      await mingle.remotes.request(c.req.param("host"), { method: "GET", path: `/v1/avatars/${file}` }),
    );
  });

  /**
   * An agent's picture, for <img> tags that cannot send the admin token. The file name is
   * random and only served while it is current; other sites may not embed it.
   */
  app.get("/v1/avatars/:file", (c) => {
    const path = mingle.avatarPath(c.req.param("file"));
    if (!path || !existsSync(path)) return c.body(null, 404);
    const ext = path.slice(path.lastIndexOf(".") + 1);
    return c.body(readFileSync(path), 200, {
      "content-type": ext === "jpg" ? "image/jpeg" : `image/${ext}`,
      "cache-control": "private, max-age=31536000, immutable",
      "cross-origin-resource-policy": "same-origin",
      "x-content-type-options": "nosniff",
    });
  });

  // ------------------------------------------------------------------ agent

  app.use("/v1/agent/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
    const agent = mingle.agentForToken(token);
    if (!agent) {
      throw new MingleError(
        "unauthorized",
        "MINGLE_TOKEN is missing or stale; this command only works inside an agent's session",
        401,
      );
    }
    c.set("agent", agent);
    c.set("line", mingle.lineForToken(token));
    // A line speaks for its agent about its task only: it reads freely, and writes only these.
    if (
      c.get("line") &&
      c.req.method !== "GET" &&
      !LINE_WRITES.some(([method, path]) => method === c.req.method && path.test(new URL(c.req.url).pathname))
    ) {
      throw new MingleError(
        "line_out_of_scope",
        "this session works on one task: it can reply and send about that task, fetch files, say how far it is with task status, finish it with task done or close it when told to stop, nothing else",
        403,
      );
    }
    // A command from the agent is progress in its turn, whatever the harness reports.
    mingle.runtime(agent.id)?.noteProgress();
    await next();
  });

  const render = (agent: Agent, m: Message) => renderMessage(store, m, { agentName: agent.name });

  /**
   * A line replies only about its task: to the message it came from, to what it said itself, or to
   * follow-ups handed to it. Throws otherwise.
   */
  const lineScope = (taskId: string, message?: Message) => {
    const task = store.taskById(taskId);
    if (task && message && (message.lineTaskId === task.id || message.id === task.fromMessage)) return;
    throw new MingleError(
      "line_out_of_scope",
      `this session works on ${task?.id ?? taskId} ("${task?.title ?? ""}"): speak only about it, in the chat it came from`,
      403,
    );
  };

  app.get("/v1/agent/whoami", (c) => {
    const agent = c.get("agent");
    const connections = store.connections(agent.id).map((n) => ({
      platform: n.platform,
      bot: n.botName,
      state: mingle.isLive(n.id) ? n.state : n.state === "connected" ? "reconnecting" : n.state,
    }));
    const line = c.get("line");
    // What it is doing at once: each line's task and how far it is (docs/spec.md 4.13).
    const doing = (line ? [store.taskById(line)].filter((t) => t !== undefined) : store.lineTasks(agent.id, 0))
      .filter((t) => t.status !== "closed" && t.lineState !== "ended")
      .map((t) => ({ id: t.id, title: t.title, status: t.status, line: t.lineState, from: t.fromMessage }));
    return c.json({
      name: agent.name,
      harness: agent.harness,
      home: mingle.homeDir(agent),
      connections,
      ...(line ? { line } : {}),
      doing,
    });
  });

  app.get("/v1/agent/manual", (c) => {
    const agent = c.get("agent");
    // The same guide the session opened with, so the variable names match what it can read.
    const names = mingle.options.harness.acceptsEnv?.(agent.harness) === false ? [] : store.envNames(agent.id);
    const task = c.get("line") ? store.taskById(c.get("line") as string) : undefined;
    return c.text(
      renderManual(
        agent.name,
        readRole(mingle.homeDir(agent)),
        process.platform,
        names.map((v) => v.name),
        task ? { taskId: task.id, title: task.title, home: mingle.homeDir(agent) } : undefined,
      ),
    );
  });

  // After the owner's stop, nothing the stopped work produces reaches a chat (docs/spec.md 4.3).
  const refuseIfStopped = (agent: Agent) => {
    if (mingle.runtime(agent.id)?.halted)
      throw new MingleError(
        "agent_stopped",
        "the owner stopped this work with /stop. Do not finish or report on it; wait for the next message",
        409,
      );
  };

  app.post("/v1/agent/messages/reply", async (c) => {
    const agent = c.get("agent");
    refuseIfStopped(agent);
    const body = await c.req.json<{ messageId: string; text: string; files?: string[] }>();
    const original = store.agentMessage(agent.id, body.messageId);
    if (!original) throw notFound("message", body.messageId);
    const line = c.get("line");
    if (line) lineScope(line, original);
    // The line's own task, or the one a line works on for this message (docs/spec.md 4.13).
    const task = line ? store.taskById(line) : store.threadlessLine(agent.id, original.id);
    // A line answering the message it works for, with a thread open: the result, for the whole chat.
    const result = Boolean(line && task?.threadChat && original.id === task.fromMessage);
    const report = await mingle.outbox.send(agent.id, {
      chatId: original.chatId,
      text: body.text ?? "",
      replyTo: original.id,
      files: resolveFiles(mingle.homeDir(agent), body.files),
      lineTaskId: line,
      // The main session acknowledging work a line took on: the work gets a thread of its own.
      ...(!line && task ? { inThread: { title: task.title } } : {}),
      ...(result ? { inChat: true } : {}),
    });
    // What it answers in the thread is how far it is; the answer to the message itself is the result.
    if (task) mingle.lineSpoke(task.id, report, { progress: Boolean(line) && original.id !== task.fromMessage });
    return c.json(report);
  });

  app.post("/v1/agent/messages/send", async (c) => {
    const agent = c.get("agent");
    refuseIfStopped(agent);
    const body = await c.req.json<{ to?: string; chatId?: string; text: string; files?: string[] }>();
    // A chat, or a person by contact or person ID: their direct chat, opened if need be.
    const to = body.to ?? body.chatId ?? "";
    const line = c.get("line");
    // A line sends only about its task: into its thread, or under the message it came from.
    const task = line ? store.taskById(line) : undefined;
    if (line && (!task?.fromChat || (to && to !== task.fromChat && to !== task.threadChat))) lineScope(line);
    if (!line && !to)
      throw new MingleError("chat_required", "usage: mingle message send --to <chat-id | contact-id> <<'MSG' ... MSG");
    // A thread opened under the message: everything but the result goes there (docs/spec.md 4.13).
    const inOwnThread = Boolean(task?.threadChat && task.threadChat !== task.fromChat);
    const chatId = task
      ? ((inOwnThread ? task.threadChat : task.fromChat) as string)
      : await sendTarget(store, (id) => mingle.liveConnection(id), agent.id, to);
    const report = await mingle.outbox.send(agent.id, {
      chatId,
      text: body.text ?? "",
      ...(task?.fromMessage && !inOwnThread ? { replyTo: task.fromMessage } : {}),
      // No thread yet: the line's first word about its work opens one, where the chat app can.
      ...(task && !task.threadChat ? { inThread: { title: task.title } } : {}),
      files: resolveFiles(mingle.homeDir(agent), body.files),
      lineTaskId: line,
    });
    if (task) mingle.lineSpoke(task.id, report, { progress: true });
    return c.json(report);
  });

  app.get("/v1/agent/chats", (c) => {
    const agent = c.get("agent");
    return c.json(
      store.agentChats(agent.id).map((chat) => ({
        id: chat.id,
        platform: chat.platform,
        kind: chat.kind,
        name: chat.name,
        lastAt: chat.lastAt,
      })),
    );
  });

  app.get("/v1/agent/chats/:id", async (c) => {
    const agent = c.get("agent");
    const chat = store.agentChat(agent.id, c.req.param("id"));
    if (!chat) throw notFound("chat", c.req.param("id"));
    const connection = store.connection(chat.connectionId);
    const live = mingle.liveConnection(chat.connectionId);
    let members: { id: string; name: string }[] | null = null;
    if (live?.capabilities().listMembers) {
      const ref = { platformId: chat.platformId, kind: chat.kind, ...(chat.name ? { name: chat.name } : {}) };
      // Each member as a contact, so the agent can name them anywhere a contact ID goes (send --to).
      members = (await live.listMembers(ref))
        .filter((m) => m.id && m.id !== live.bot.id)
        .map((m) => {
          let contact = store.touchContact(chat.connectionId, m.id, m.name);
          if (m.isBot && !contact.isBot) contact = store.setContactBot(contact.id, true) ?? contact;
          return {
            id: contact.id,
            name: contactName(contact) ?? m.name,
            profile: contact.profile,
            bot: contact.isBot,
          };
        });
    }
    // A group that hears everything (or a thread of one): how often it reaches the agent.
    const group = chat.parentId ? store.chat(chat.parentId) : chat;
    const hearing = chat.kind !== "dm" && group?.listen ? mingle.hearingView(group) : null;
    return c.json({ id: chat.id, platform: connection?.platform, kind: chat.kind, name: chat.name, members, hearing });
  });

  /**
   * The agent sets how often a group that hears everything reaches it (docs/spec.md 4.2):
   * `{ "every": "1h" }`, `{ "mute": true }` (until someone addresses it there) or `{ "default": true }`.
   */
  app.put("/v1/agent/chats/:id/hearing", async (c) => {
    const body = await c.req.json<{ every?: unknown; mute?: unknown; default?: unknown }>();
    const given = [body.every !== undefined, body.mute === true, body.default === true].filter(Boolean).length;
    if (given !== 1)
      throw new MingleError(
        "hearing_invalid",
        'send one of { "every": "1h" }, { "mute": true } or { "default": true }',
      );
    if (body.every !== undefined && typeof body.every !== "string")
      throw new MingleError("hearing_invalid", 'give "every" as a duration, like "1h"');
    const pace: HearPace =
      typeof body.every === "string"
        ? { kind: "every", ms: parseDuration(body.every) }
        : body.mute === true
          ? { kind: "muted" }
          : { kind: "auto" };
    const { chat, view } = mingle.setHearPace(c.get("agent").id, c.req.param("id"), pace);
    return c.json({ chat: chat.id, ...view });
  });

  /**
   * The agent adds or removes a name a group calls it by (docs/spec.md 4.2): `{ "alias": "小跟班" }`.
   * A thread stands for its group.
   */
  for (const method of ["post", "delete"] as const) {
    app[method]("/v1/agent/chats/:id/aliases", async (c) => {
      const { alias } = objectBody(await c.req.json<unknown>());
      if (typeof alias !== "string") throw new MingleError("alias_invalid", 'send { "alias": "<name>" }');
      const { chat, aliases } = mingle.alias(c.get("agent").id, c.req.param("id"), alias, method === "post");
      return c.json({ chat: chat.id, aliases });
    });
  }

  const contactView = (k: Contact & { platform: Platform; owner: boolean }) => ({
    id: k.id,
    platform: k.platform,
    name: contactName(k),
    platformName: k.name,
    alias: k.alias,
    owner: k.owner,
    bot: k.isBot && !k.owner,
    person: k.personId,
    linkedBy: k.linkedBy,
    profile: k.profile,
  });

  app.get("/v1/agent/contacts", (c) => {
    // `q`: words that must all appear in one of their names (given, platform or person), any case.
    const words = (c.req.query("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const all = store.agentContacts(c.get("agent").id);
    const found = words.length
      ? all.filter((k) => {
          const names = [contactName(k), k.name, k.alias].filter(Boolean).join(" ").toLowerCase();
          return words.every((w) => names.includes(w));
        })
      : all;
    return c.json(found.map(contactView));
  });

  app.get("/v1/agent/contacts/:id", (c) => c.json(people.info(store, c.get("agent").id, c.req.param("id"))));

  /** Name a contact, or the person it belongs to (every account of theirs shows the name). */
  app.patch("/v1/agent/contacts/:id", async (c) => {
    const agent = c.get("agent");
    const id = c.req.param("id");
    const body = await c.req.json<{ name?: unknown }>();
    people.rename(store, agent.id, id, contactAlias(body.name));
    const { person, accounts } = people.resolve(store, agent.id, id);
    return c.json({ id, name: person?.name ?? contactName(accounts[0]) });
  });

  app.post("/v1/agent/contacts/link", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{ ids?: unknown }>();
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    const person = people.link(store, agent.id, ids, "agent");
    return c.json(people.info(store, agent.id, person.id));
  });

  app.post("/v1/agent/contacts/:id/unlink", (c) => {
    const agent = c.get("agent");
    people.unlink(store, agent.id, c.req.param("id"), "agent");
    return c.json({ ok: true });
  });

  app.put("/v1/agent/contacts/:id/note", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{ note?: unknown }>();
    if (body.note !== null && typeof body.note !== "string") {
      throw new MingleError("note_invalid", "pass the note on standard input, or --clear to remove it");
    }
    const person = people.writeNote(store, agent.id, c.req.param("id"), body.note);
    return c.json({ person: person?.id ?? null, note: person?.note ?? null });
  });

  app.get("/v1/agent/chats/:id/messages", (c) => {
    const agent = c.get("agent");
    const chat = store.agentChat(agent.id, c.req.param("id"));
    if (!chat) throw notFound("chat", c.req.param("id"));
    const limit = clamp(Number(c.req.query("limit") ?? 30), 1, 200);
    const around = c.req.query("around");
    const since = c.req.query("since");
    const before = c.req.query("before");
    if ([around, since, before].filter(Boolean).length > 1)
      throw new MingleError("flags_conflict", "pass only one of --before, --since and --around");
    if (before && !store.hasMessage(chat.id, before)) throw notFound("message", before);
    const messages = around
      ? store.chatAround(chat.id, around, limit)
      : since
        ? store.chatSince(chat.id, since, limit)
        : store.chatMessages(chat.id, limit, before);
    if (!messages) throw notFound("message", around ?? since ?? "");
    return c.json(messages.map((m) => ({ id: m.id, text: render(agent, m) })));
  });

  app.get("/v1/agent/messages/search", (c) => {
    const agent = c.get("agent");
    const q = (c.req.query("q") ?? "").trim();
    if (!q)
      throw new MingleError("query_required", 'pass what to search for, like: mingle message search "ridge route"');
    const chatId = c.req.query("in");
    if (chatId && !store.agentChat(agent.id, chatId)) throw notFound("chat", chatId);
    const messages = store.search(agent.id, q, chatId, clamp(Number(c.req.query("limit") ?? 20), 1, 100));
    // Each hit is the text around the match, not the whole message (docs/spec.md 5.3).
    return c.json(
      messages.map((m) => ({ id: m.id, chat: m.chatId, text: render(agent, { ...m, body: excerpt(m.body, q) }) })),
    );
  });

  app.post("/v1/agent/files/:id/download", async (c) => {
    const agent = c.get("agent");
    const { to, dir } = await c.req.json<{ to?: string; dir?: string }>();
    const found = store.attachment(agent.id, c.req.param("id"));
    if (!found) throw notFound("file", c.req.param("id"));
    const live = mingle.liveConnection(found.chat.connectionId);
    if (!live) throw new MingleError("not_connected", "the chat app connection is offline; try again in a minute", 503);
    if (!live.capabilities().fileDownload) {
      throw new MingleError("unsupported", "this chat app does not let bots download files");
    }
    const destination = to ?? (dir ? resolve(dir, basename(found.attachment.name)) : undefined);
    if (!destination || !isAbsolute(destination))
      throw new MingleError("invalid_path", "the download path must be absolute");
    const target = resolve(destination);
    mkdirSync(dirname(target), { recursive: true });
    await live.download({ id: found.attachment.ref, name: found.attachment.name }, target);
    return c.json({ path: target, name: found.attachment.name });
  });

  app.post("/v1/agent/tasks", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{ title: string; from?: string }>();
    if (!body.title?.trim())
      throw new MingleError("title_required", 'give the task a title: mingle task create "Compare the routes"');
    let fromChat: string | null = null;
    if (body.from) {
      const message = store.agentMessage(agent.id, body.from);
      if (!message) throw notFound("message", body.from);
      fromChat = message.chatId;
    }
    return c.json(
      store.createTask({ agentId: agent.id, title: body.title.trim(), fromMessage: body.from ?? null, fromChat }),
    );
  });

  app.get("/v1/agent/tasks", (c) => {
    const agent = c.get("agent");
    const line = c.get("line");
    // A line sees the task it works on.
    if (line) return c.json([store.taskById(line)].filter(Boolean));
    return c.json(store.tasks(agent.id, c.req.query("all") === "1"));
  });

  /** Start a line for work that takes a while (docs/spec.md 4.13): the brief comes on standard input. */
  app.post("/v1/agent/tasks/run", async (c) => {
    const agent = c.get("agent");
    refuseIfStopped(agent);
    const body = await c.req.json<{ title?: string; from?: string; brief?: string }>();
    if (!body.title?.trim())
      throw new MingleError(
        "title_required",
        'give the task a title: mingle task run "Fix the login" --from <message-id>',
      );
    if (!body.from)
      throw new MingleError("from_required", "pass --from <message-id>: the message the work is for, where it answers");
    if (!body.brief?.trim())
      throw new MingleError("brief_required", "pass the brief on standard input: what to do, and what done looks like");
    const task = mingle.runTask(agent.id, { title: body.title.trim(), from: body.from, brief: body.brief.trim() });
    // Whether the acknowledgement opens a thread for the work, so the main session can say where to follow it.
    return c.json({ ...task, thread: task.threadChat ? "existing" : mingle.canOpenThread(task) ? "opens" : "none" });
  });

  /** Pass a message, a note, or both on to a line. */
  app.post("/v1/agent/tasks/:id/tell", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{ text?: string; from?: string }>();
    return c.json(
      mingle.tellTask(agent.id, c.req.param("id"), {
        ...(body.text ? { text: body.text } : {}),
        ...(body.from ? { from: body.from } : {}),
      }),
    );
  });

  /** A line finishes its task with a summary for the main session. */
  app.post("/v1/agent/tasks/:id/done", async (c) => {
    const agent = c.get("agent");
    const line = c.get("line");
    if (line !== c.req.param("id")) {
      throw new MingleError(
        "line_only",
        line
          ? `this session works on ${line}; finish that one`
          : "task done is how a line finishes its task; for your own, use task update <id> --status done",
        403,
      );
    }
    const { summary } = await c.req.json<{ summary?: string }>();
    return c.json(mingle.doneTask(agent.id, line, summary ?? ""));
  });

  /** A line says how far it is, for the console, where it has no thread to say it in (docs/spec.md 4.13). */
  app.post("/v1/agent/tasks/progress", async (c) => {
    const agent = c.get("agent");
    const line = c.get("line");
    if (!line) {
      throw new MingleError(
        "line_only",
        "task status is how a line says how far it is; tell people in the chat instead",
        403,
      );
    }
    const { text } = await c.req.json<{ text?: string }>();
    if (!text?.trim())
      throw new MingleError("text_required", 'say how far you are: mingle task status "Found the cause"');
    return c.json(mingle.taskProgress(agent.id, line, text));
  });

  app.patch("/v1/agent/tasks/:id", async (c) => {
    const agent = c.get("agent");
    const { status } = await c.req.json<{ status: TaskStatus }>();
    const line = c.get("line");
    // A line may close its own task when someone tells it to stop; nothing else.
    if (line && (line !== c.req.param("id") || status !== "closed")) {
      throw new MingleError(
        "line_out_of_scope",
        `this session can only close its own task when told to stop: task update ${line} --status closed`,
        403,
      );
    }
    if (!TASK_STATUSES.includes(status)) {
      throw new MingleError("invalid_status", `use one of: ${TASK_STATUSES.join(", ")}`);
    }
    return c.json(mingle.setTaskStatus(agent.id, c.req.param("id"), status, Boolean(line)));
  });

  app.post("/v1/agent/reminders", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{
      text: string;
      in?: string;
      at?: string;
      every?: string;
      chat?: string;
      from?: string;
      check?: string;
      once?: boolean;
      for?: string;
    }>();
    if (!body.text?.trim())
      throw new MingleError(
        "text_required",
        'say what to be reminded of: mingle reminder set "Check the forecast" --in 6h',
      );
    if (body.chat && !store.agentChat(agent.id, body.chat)) throw notFound("chat", body.chat);
    // Set for a message: its chat is the reminder's chat.
    let chatId = body.chat ?? null;
    if (body.from) {
      const source = store.agentMessage(agent.id, body.from);
      if (!source) throw notFound("message", body.from);
      if (chatId && chatId !== source.chatId) {
        throw new MingleError(
          "chat_mismatch",
          `${body.from} is in ${source.chatId}; leave out --chat when you pass --from`,
        );
      }
      chatId = source.chatId;
    }
    if (body.for !== undefined && body.check === undefined)
      throw new MingleError("check_required", "--for goes with --check: it says how long to keep checking");
    if (body.once && body.check === undefined)
      throw new MingleError("check_required", "--once goes with --check: it ends the reminder after the first change");
    if (body.check !== undefined && !body.every)
      throw new MingleError("check_needs_every", "a check runs on a schedule: pass --every 5m with --check");
    const now = Date.now();
    let rule = "once";
    let next: number;
    if (body.every) {
      rule = body.every.includes(":") || body.every.includes("@") ? body.every : `every:${body.every}`;
      next = nextFire(rule, now);
    } else if (body.in) {
      next = now + parseDuration(body.in);
    } else if (body.at) {
      next = Date.parse(body.at);
      if (Number.isNaN(next) || next <= now) {
        throw new MingleError("invalid_time", "--at needs a future ISO 8601 time, like 2026-11-12T09:00+08:00");
      }
    } else {
      throw new MingleError("when_required", "pass one of --in 30m, --at <time> or --every daily@09:00");
    }
    // A check runs once now: a broken command fails here, and the agent sees where things stand.
    let check: { command: string; once: boolean; hash: string; until: number | null } | null = null;
    // The first run's output goes back in this response only; only its hash is kept.
    let checkOutput: string | null = null;
    if (body.check !== undefined) {
      const command = checkCommand(body.check);
      if (rule.startsWith("every:") && nextFire(rule, now) - now < CHECK_MIN_INTERVAL_MS)
        throw new MingleError("check_too_often", "check at most once a minute: --every 1m or longer");
      const until = checkUntil(body.for, now);
      const result = await mingle.probeCheck(agent.id, command);
      if (!result.ok)
        throw new MingleError(
          "check_failed",
          `the check ${result.error}. Fix the command and set the reminder again; it must exit 0`,
        );
      check = { command, once: body.once === true, hash: result.hash, until };
      checkOutput = result.output;
    }
    const reminder = store.createReminder({
      check,
      agentId: agent.id,
      body: body.text.trim(),
      rule,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      chatId,
      sourceMessageId: body.from ?? null,
      nextFireAt: next,
    });
    return c.json(check ? { ...reminder, checkOutput } : reminder);
  });

  // "Not yet, look again in 2h": the next fire moves to `by` from now; a recurring reminder then keeps its rule.
  app.post("/v1/agent/reminders/:id/snooze", async (c) => {
    const agent = c.get("agent");
    const { by } = await c.req.json<{ by?: string }>();
    if (!by) throw new MingleError("duration_required", "say how long to wait: mingle reminder snooze r2 --by 2h");
    const next = Date.now() + parseDuration(by);
    const reminder = store.setReminderNext(agent.id, c.req.param("id"), next);
    if (!reminder) throw notFound("reminder", c.req.param("id"));
    return c.json(reminder);
  });

  app.get("/v1/agent/reminders", (c) => c.json(store.reminders(c.get("agent").id)));

  app.delete("/v1/agent/reminders/:id", (c) => {
    const agent = c.get("agent");
    if (!store.deleteReminder(agent.id, c.req.param("id"))) throw notFound("reminder", c.req.param("id"));
    mingle.abortCheck(agent.id, c.req.param("id"));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ admin

  app.use("/v1/admin/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    if (token !== mingle.adminToken)
      throw new MingleError("unauthorized", "admin token mismatch; is this the running Mingle?", 401);
    await next();
  });

  app.use("/v1/admin/*", remoteGateway(mingle.remotes));
  app.get("/v1/admin/ssh/config", async (c) => c.json(await readSshConfig()));
  app.get("/v1/admin/ssh/hosts", (c) => c.json(mingle.remotes.list()));
  app.post("/v1/admin/ssh/hosts", async (c) => c.json(await mingle.remotes.add(await c.req.json()), 201));
  app.post("/v1/admin/ssh/installations", async (c) => c.json(mingle.remotes.install(await c.req.json()), 202));
  app.get("/v1/admin/ssh/installations/:id", (c) => c.json(mingle.remotes.installation(c.req.param("id"))));

  const agentView = (agent: Agent) => {
    const connections = store.connections(agent.id);
    const shared = sharedOwners(connections);
    return {
      ...agent,
      avatar: agent.avatar ? `/v1/avatars/${agent.avatar}` : null,
      harnessName: mingle.harnessName(agent.id),
      home: mingle.homeDir(agent),
      role: readRole(mingle.homeDir(agent)),
      connections: connections.map((n) => ({
        id: n.id,
        platform: n.platform,
        bot: n.botName,
        state: n.state,
        detail: n.stateDetail,
        retryAt: mingle.retryAt(n.id),
        owner: n.ownerId !== null,
        ownerContact: ownerContact(n.id, n.ownerId),
        ownerShared: shared.has(n.id),
        invite: inviteUrl(n.platform, n.botId, n.botName),
        trust: trustOf(n.platform),
        claim: claimView(n),
      })),
      requests: accessRequests(agent.id),
      // Things under way at once, besides talking (docs/spec.md 4.13).
      doing: mingle.lines.busy(agent.id),
    };
  };

  /**
   * How the owner claims a bot the platform named no owner for (docs/spec.md 4.7): the code to send
   * it, while one is valid, and where the platform has one, a link that sends it in one tap. Null
   * when the bot has its owner, or nobody can message it directly.
   */
  const claimView = (n: Connection) => {
    if (n.ownerId) return null;
    let channel: ReturnType<typeof mingle.channel> | undefined;
    try {
      channel = mingle.channel(n.platform);
    } catch {
      return null;
    }
    if (channel.directMessages === false) return null;
    const code = n.claimCode && (n.claimExpiresAt ?? 0) > Date.now() ? n.claimCode : null;
    return {
      code,
      expiresAt: code ? n.claimExpiresAt : null,
      url: code && n.botId ? (channel.claimUrl?.({ id: n.botId, name: n.botName ?? "" }, code) ?? null) : null,
    };
  };

  /**
   * People and groups waiting for the owner to let them in, one entry each, oldest first: who, on
   * which chat app, and the first thing they sent, so the owner can tell who it is.
   */
  const accessRequests = (agentId: string) => {
    const requests = new Map<
      string,
      {
        kind: "contact" | "group";
        id: string;
        platform: Platform;
        name: string | null;
        sender: string | null;
        preview: string;
        count: number;
        at: number;
      }
    >();
    for (const m of store.heldMessages(agentId)) {
      const contact = m.senderId ? store.contactByPlatformId(m.connectionId, m.senderId) : undefined;
      const sender = contactName(contact) ?? (m.senderName && m.senderName !== m.senderId ? m.senderName : null);
      const group = m.chat.kind === "dm" ? undefined : m.chat.parentId ? store.chat(m.chat.parentId) : m.chat;
      const key = group ? `g:${group.id}` : `c:${contact?.id ?? m.senderId}`;
      const known = requests.get(key);
      if (known) {
        known.count++;
        continue;
      }
      if (!group && !contact) continue;
      requests.set(key, {
        kind: group ? "group" : "contact",
        id: group ? group.id : (contact as { id: string }).id,
        platform: m.platform,
        name: group ? group.name : sender,
        sender,
        preview: [...m.body.replace(/\s+/g, " ").trim()].slice(0, 160).join(""),
        count: 1,
        at: m.createdAt,
      });
    }
    return [...requests.values()];
  };

  /**
   * Connections whose owner is not the only one on that platform: two WeChat accounts scanned by two
   * people, say. There "you" would be two people, so the console names them instead.
   */
  const sharedOwners = (connections: readonly Connection[]): Set<string> => {
    // Owners the owner linked as one person in the console are one human, whatever their IDs.
    const who = (n: Connection) => {
      const k = n.ownerId ? store.contactByPlatformId(n.id, n.ownerId) : undefined;
      return k?.personId && k.linkedBy === "owner" ? `p:${k.personId}` : `u:${n.ownerId}`;
    };
    return new Set(
      connections
        .filter((n) => n.ownerId)
        .filter((n) => connections.some((o) => o.platform === n.platform && o.ownerId && who(o) !== who(n)))
        .map((n) => n.id),
    );
  };

  /** Who owns this bot, as the console names them. */
  const ownerContact = (connectionId: string, ownerId: string | null) => {
    if (!ownerId) return null;
    const contact = store.contactByPlatformId(connectionId, ownerId);
    return contact ? { id: contact.id, name: contactName(contact) } : null;
  };

  /** Who can reach a bot on this platform (docs/spec.md 4.7); undeclared reads as `public`, as the gate does. */
  const trustOf = (platform: Platform): Trust => {
    try {
      return mingle.channel(platform).trust ?? "public";
    } catch {
      return "public";
    }
  };

  const inviteUrl = (platform: Platform, botId: string | null, botName: string | null): string | null => {
    if (!botId) return null;
    try {
      return mingle.channel(platform).inviteUrl?.({ id: botId, name: botName ?? "" }) ?? null;
    } catch {
      return null;
    }
  };

  app.get("/v1/admin/status", async (c) =>
    c.json({
      version: VERSION,
      agents: [
        ...store.agents().map(agentView),
        ...(c.req.query("local") === "1" ? [] : await mingle.remotes.agents()),
      ],
    }),
  );

  /**
   * Every agent in a line, for the desktop app's menu bar icon (docs/spec.md 9.1): its state, what it
   * works on, and what needs the owner. Counts and titles only: no message content or people.
   */
  app.get("/v1/admin/summary", (c) =>
    c.json({
      version: VERSION,
      agents: store.agents().map((agent) => {
        const connections = store.connections(agent.id);
        const given = store.retryable(agent.id);
        return {
          id: agent.id,
          slug: agent.slug,
          name: agent.name,
          status: agent.status,
          task: store.tasks(agent.id, false).find((t) => t.status === "in_progress")?.title ?? null,
          // `retrying`: offline but Mingle tries again by itself, so it is "down", not something to fix.
          connections: connections.map((n) => ({
            id: n.id,
            platform: n.platform,
            bot: n.botName,
            state: n.state,
            retrying: mingle.retryAt(n.id) !== null,
          })),
          failed: given.filter((m) => m.state === "failed").length,
          unanswered: given.filter((m) => m.state === "unanswered").length,
        };
      }),
    }),
  );
  app.get("/v1/admin/harnesses", async (c) => c.json(await mingle.availableHarnesses()));
  app.get("/v1/admin/harnesses/:id/models", async (c) => c.json(await mingle.harnessModels(c.req.param("id"))));
  /** Every harness OAR knows, installed or not: the console offers to install or sign in the rest. */
  app.get("/v1/admin/brains", async (c) => {
    // `?fresh=1` probes again; without it the last probe answers at once.
    const catalog = await mingle.brainCatalog(c.req.query("fresh") === "1");
    return c.json(
      catalog.map((brain) => {
        const installJob = mingle.brains.active(brain.id, "install");
        const upgradeJob = mingle.brains.active(brain.id, "upgrade");
        return { ...brain, ...(installJob ? { installJob } : {}), ...(upgradeJob ? { upgradeJob } : {}) };
      }),
    );
  });
  app.get("/v1/admin/brains/:id/sign-in", async (c) =>
    c.json((await mingle.options.harness.signInState?.(c.req.param("id"))) ?? { kind: "unknown" }),
  );
  app.get("/v1/admin/brains/:id/install-plan", async (c) =>
    c.json((await mingle.options.harness.installPlan?.(c.req.param("id"))) ?? { kind: "unsupported", detail: "" }),
  );
  app.post("/v1/admin/brains/:id/install", (c) => c.json(mingle.brains.install(c.req.param("id"))));
  app.get("/v1/admin/brains/:id/update", async (c) =>
    c.json(
      (await mingle.options.harness.updateCheck?.(c.req.param("id")).catch(() => undefined)) ?? { kind: "unknown" },
    ),
  );
  app.get("/v1/admin/brains/:id/usage", async (c) => c.json(await mingle.brains.usage(c.req.param("id"))));
  app.post("/v1/admin/brains/:id/upgrade", (c) => c.json(mingle.brains.upgrade(c.req.param("id"))));
  app.post("/v1/admin/brains/:id/sign-in", (c) => c.json(mingle.brains.signIn(c.req.param("id"))));
  app.get("/v1/admin/jobs/:id", (c) => c.json(mingle.brains.get(c.req.param("id"))));
  app.post("/v1/admin/jobs/:id/answer", async (c) => {
    const { value } = await c.req.json<{ value: string }>();
    mingle.brains.answer(c.req.param("id"), String(value ?? ""));
    return c.json({ ok: true });
  });
  app.delete("/v1/admin/jobs/:id", (c) => {
    mingle.brains.cancel(c.req.param("id"));
    return c.json({ ok: true });
  });

  /** Every first-batch platform, with how to connect it, or null when it is not built yet. */
  app.get("/v1/admin/platforms", (c) => {
    const all: Platform[] = [
      "wechat",
      "wecom",
      "feishu",
      "dingtalk",
      "qq",
      "slack",
      "discord",
      "telegram",
      "github",
      "imessage",
    ];
    // Channels that exist only on some systems (iMessage on macOS) are left out elsewhere, not shown as "soon".
    const local: readonly Platform[] = ["imessage"];
    return c.json(
      all
        .filter((platform) => !local.includes(platform) || mingle.hasChannel(platform))
        .map((platform) => {
          let onboarding: OnboardingMethod | null = null;
          let manualFields: readonly CredentialField[] = [];
          let manualSetupUrl: string | null = null;
          let setup = false;
          let reauthorize = false;
          try {
            const channel = mingle.channel(platform);
            onboarding = channel.onboarding;
            manualFields = channel.manualFields ?? [];
            manualSetupUrl = channel.manualSetupUrl ?? null;
            setup = Boolean(channel.setup);
            reauthorize = Boolean(channel.reauthorize);
          } catch {}
          return { platform, onboarding, manualFields, manualSetupUrl, setup, reauthorize };
        }),
    );
  });

  /** Local prerequisites (iMessage: macOS permissions), polled by the connect screen. Never prompts. */
  app.get("/v1/admin/platforms/:platform/setup", async (c) => {
    const setup = mingle.channel(c.req.param("platform") as Platform).setup;
    if (!setup) throw new MingleError("setup_not_needed", "this chat app has nothing to set up on this computer", 404);
    return c.json(await setup.check());
  });

  /** A setup step the person clicked: open a settings pane, or let macOS ask for a permission. */
  app.post("/v1/admin/platforms/:platform/setup/:action", async (c) => {
    const setup = mingle.channel(c.req.param("platform") as Platform).setup;
    const action = c.req.param("action");
    if (!setup?.actions.includes(action)) throw new MingleError("setup_action_unknown", "reload the page", 404);
    await setup.act(action);
    return c.json(await setup.check());
  });

  /** One message as the console shows it in the activity: who said it, where, and what became of it. */
  const activityView = (agent: Agent) => {
    const connections = store.connections(agent.id);
    const owners = new Set(connections.map((n) => `${n.id}:${n.ownerId}`));
    const shared = sharedOwners(connections);
    // The work a message started, or the line it went to (docs/spec.md 4.13).
    const lines = store.lineTasks(agent.id, 0);
    const lineOf = (m: Message) => {
      const task = m.lineTaskId ? lines.find((t) => t.id === m.lineTaskId) : lines.find((t) => t.fromMessage === m.id);
      return task
        ? { id: task.id, title: task.title, state: lineState(task), started: task.fromMessage === m.id }
        : null;
    };
    return (m: Message & { chat: Chat; platform: Platform }) => {
      const contact =
        m.direction === "in" && m.senderId ? store.contactByPlatformId(m.chat.connectionId, m.senderId) : undefined;
      const senderIsOwner = m.direction === "in" && owners.has(`${m.chat.connectionId}:${m.senderId}`);
      return {
        id: m.id,
        direction: m.direction,
        triggers: m.triggers,
        platform: m.platform,
        chat: { id: m.chat.id, kind: m.chat.kind, name: m.chat.name },
        // A platform ID is not a name: send null and let the console label the person.
        sender:
          m.direction === "out"
            ? agent.name
            : (contactName(contact) ?? (m.senderName && m.senderName !== m.senderId ? m.senderName : null)),
        senderIsOwner,
        /** The console may call an unnamed owner "you" only when that cannot mean two people. */
        senderIsOnlyOwner: senderIsOwner && !shared.has(m.chat.connectionId),
        senderIsBot: !senderIsOwner && Boolean(contact?.isBot),
        contactId: contact?.id ?? null,
        body: m.body,
        state: m.state,
        /** While waiting for a passing failure: when Mingle tries it again. */
        retryAt: m.state === "waiting" ? (m.retryAt ?? null) : null,
        files: m.attachments.map((a) => a.name),
        createdAt: m.createdAt,
        line: lineOf(m),
      };
    };
  };

  app.get("/v1/admin/agents/:id/activity", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const limit = clamp(Number(c.req.query("limit") ?? 30), 1, 200);
    return c.json(store.agentActivity(agent.id, limit).map(activityView(agent)));
  });

  /**
   * The activity by conversation (DESIGN.md "Agent · 动态"): the chats that spoke last, each with its
   * latest messages and whatever still needs the owner. `chat` and `before` page one chat further back.
   */
  app.get("/v1/admin/agents/:id/conversations", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const chatId = c.req.query("chat");
    if (chatId && !store.agentChat(agent.id, chatId)) throw notFound("chat", chatId);
    const before = c.req.query("before");
    const view = activityView(agent);
    const conversations = store.agentConversations(agent.id, {
      chats: clamp(Number(c.req.query("limit") ?? 20), 1, 100),
      messages: clamp(Number(c.req.query("messages") ?? 6), 1, 50),
      ...(chatId ? { chatId } : {}),
      ...(before ? { before: Number(before) } : {}),
    });
    return c.json(
      conversations.map((v) => ({
        chat: { id: v.chat.id, kind: v.chat.kind, name: v.chat.name },
        parent: v.parent ? { id: v.parent.id, kind: v.parent.kind, name: v.parent.name } : null,
        platform: v.platform,
        // A group: whether it hears everything (docs/spec.md 4.2). Null where that cannot be set:
        // not a group, or a chat app that only sends the bot what @s it.
        listen:
          v.chat.kind === "group" && mingle.hasChannel(v.platform) && mingle.channel(v.platform).groupMessages
            ? v.chat.listen
            : null,
        // A group that hears everything: the pace the agent set, or the slowing in force.
        hearing: v.chat.kind === "group" && v.chat.listen ? mingle.hearingView(v.chat) : null,
        latestAt: v.latestAt,
        earlier: v.earlier,
        cursor: v.cursor,
        messages: v.messages.map((m) => view({ ...m, chat: v.chat, platform: v.platform })),
      })),
    );
  });

  /**
   * The owner edits someone in the agent's address book: `name` names them, or the person they are
   * linked to (empty clears it); `note` writes the person's note; `bot` marks an account that is a
   * bot though the platform does not say so (docs/spec.md 4.2). Fields left out stay as they are.
   */
  app.patch("/v1/admin/agents/:id/contacts/:contactId", async (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const id = c.req.param("contactId");
    const found = store.agentContact(agent.id, id);
    if (!found) throw notFound("contact", id);
    const body = await c.req.json<{ name?: unknown; bot?: unknown; note?: unknown }>();
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
      throw new MingleError("note_invalid", "pass the note as text");
    }
    if (body.bot !== undefined && typeof body.bot !== "boolean") {
      throw new MingleError("bot_invalid", "pass bot as true or false");
    }
    if (body.bot === true && store.connection(found.connectionId)?.ownerId === found.platformId) {
      throw new MingleError("contact_is_owner", "the owner is a person; their messages always reach the agent", 409);
    }
    const name = "name" in body ? contactAlias(body.name) : undefined;
    if (name !== undefined) store.nameContact(id, name);
    if (typeof body.bot === "boolean") store.setContactBot(id, body.bot);
    // A note sits on the person; an account on its own gets one to hold it.
    if (body.note !== undefined) people.writeNote(store, agent.id, id, (body.note as string | null) || null);
    const contact = store.contact(id);
    return c.json({ id, name: contactName(contact), bot: contact?.isBot ?? false });
  });

  /**
   * The agent's address book for the console: people with their accounts, and accounts on their
   * own, most recently active first (docs/spec.md 4.2).
   */
  app.get("/v1/admin/agents/:id/contacts", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const shared = sharedOwners(store.connections(agent.id));
    // Who talked to the agent, or whom someone already decided something about. Group members it
    // only knows from the member list stay in its address book, not on the owner's page.
    const wrote = store.contactsWhoWrote(agent.id);
    const all = store
      .agentContacts(agent.id)
      .filter((k) => wrote.has(k.id) || k.owner || k.personId || k.alias || k.access !== null);
    const account = (k: (typeof all)[number]) => ({
      id: k.id,
      platform: k.platform,
      connection: k.connectionId,
      name: k.alias ?? k.name,
      platformName: k.name,
      // The owner always reaches the agent: there is nothing to decide for them.
      access: k.owner ? null : k.access,
      owner: k.owner,
      ownerShared: k.owner && shared.has(k.connectionId),
      bot: k.isBot && !k.owner,
      linkedBy: k.linkedBy,
      profile: k.profile,
    });
    const byPerson = new Map(store.agentPeople(agent.id).map((p) => [p.id, p]));
    const seen = new Set<string>();
    const entries: unknown[] = [];
    for (const k of all) {
      if (!k.personId) {
        entries.push({ person: null, name: contactName(k), note: null, accounts: [account(k)] });
        continue;
      }
      if (seen.has(k.personId)) continue;
      seen.add(k.personId);
      const person = byPerson.get(k.personId);
      const members = all.filter((m) => m.personId === k.personId);
      entries.push({
        person: k.personId,
        name: person?.name ?? null,
        note: person?.note ?? null,
        accounts: members.map(account),
      });
    }
    return c.json(entries);
  });

  /** The owner says these accounts are one person. Their links can carry permissions later; the agent's cannot. */
  app.post("/v1/admin/agents/:id/people/link", async (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const body = await c.req.json<{ contacts?: unknown }>();
    const ids = Array.isArray(body.contacts) ? body.contacts.filter((x): x is string => typeof x === "string") : [];
    const person = people.link(store, agent.id, ids, "owner");
    return c.json({ person: person.id });
  });

  app.post("/v1/admin/agents/:id/people/unlink", async (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const body = await c.req.json<{ contact?: unknown }>();
    if (typeof body.contact !== "string") throw new MingleError("contact_required", "pass the contact to unlink");
    people.unlink(store, agent.id, body.contact, "owner");
    return c.json({ ok: true });
  });

  /** The owner names a person or writes their note. Fields left out stay as they are; empty clears. */
  app.put("/v1/admin/agents/:id/people/:personId", async (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const id = c.req.param("personId");
    if (!store.agentPerson(agent.id, id)) throw notFound("contact", id);
    const body = await c.req.json<{ name?: unknown; note?: unknown }>();
    if ("name" in body) store.updatePerson(id, { name: contactAlias(body.name) });
    if ("note" in body) {
      if (body.note !== null && typeof body.note !== "string")
        throw new MingleError("note_invalid", "pass the note as text");
      people.writeNote(store, agent.id, id, body.note);
    }
    const person = store.person(id);
    return c.json({ person: id, name: person?.name ?? null, note: person?.note ?? null });
  });

  /** Let a person in, or turn them away (docs/spec.md 4.7). What they sent meanwhile follows. */
  app.post("/v1/admin/agents/:id/contacts/:contactId/access", async (c) => {
    const settled = mingle.setAccess(c.req.param("id"), { contact: c.req.param("contactId") }, await accessBody(c));
    return c.json({ settled });
  });

  /** The same for a group. */
  app.post("/v1/admin/agents/:id/chats/:chatId/access", async (c) => {
    const settled = mingle.setAccess(c.req.param("id"), { chat: c.req.param("chatId") }, await accessBody(c));
    return c.json({ settled });
  });

  /**
   * The owner sets a group to hear everything, or only what is addressed to the agent (docs/spec.md
   * 4.2): `{ "listen": true }` or `{ "listen": false }`.
   */
  app.put("/v1/admin/agents/:id/chats/:chatId/listen", async (c) => {
    const { listen } = await c.req.json<{ listen?: unknown }>();
    if (typeof listen !== "boolean")
      throw new MingleError("listen_invalid", 'send { "listen": true } or { "listen": false }');
    mingle.setListen(c.req.param("id"), c.req.param("chatId"), listen);
    return c.json({ listen });
  });

  /**
   * The owner picks how fast a group keeps up with a conversation (docs/spec.md 4.2):
   * `{ "tier": "save" | "balanced" | "fast" | null }`, null following the group's size.
   */
  app.put("/v1/admin/agents/:id/chats/:chatId/hearing", async (c) => {
    const { tier } = objectBody(await c.req.json<unknown>());
    if (tier !== null && tier !== "save" && tier !== "balanced" && tier !== "fast")
      throw new MingleError("tier_invalid", 'send { "tier": "save" }, "balanced", "fast" or null');
    return c.json(mingle.setHearTier(c.req.param("id"), c.req.param("chatId"), tier));
  });

  /**
   * The owner adds or removes one name a group calls the agent by: `{ "alias": "小跟班" }`. One at a
   * time, applied to the list as it is now, so a name the agent added meanwhile is kept.
   */
  for (const method of ["post", "delete"] as const) {
    app[method]("/v1/admin/agents/:id/chats/:chatId/aliases", async (c) => {
      const { alias } = objectBody(await c.req.json<unknown>());
      if (typeof alias !== "string") throw new MingleError("alias_invalid", 'send { "alias": "<name>" }');
      return c.json(mingle.ownerAlias(c.req.param("id"), c.req.param("chatId"), alias, method === "post"));
    });
  }

  /** The owner puts a group back on Mingle's own pace, whatever the agent set (docs/spec.md 4.2). */
  app.delete("/v1/admin/agents/:id/chats/:chatId/hearing", (c) =>
    c.json(mingle.resetHearPace(c.req.param("id"), c.req.param("chatId"))),
  );

  /** The people and groups the owner (or the default) let in or turned away, to change their mind. */
  app.get("/v1/admin/agents/:id/access", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const decided = store.decidedAccess(agent.id);
    return c.json([
      ...decided.contacts.map((k) => ({
        kind: "contact" as const,
        id: k.id,
        platform: k.platform,
        connection: k.connectionId,
        name: contactName(k),
        access: k.access,
        updatedAt: k.updatedAt,
      })),
      ...decided.groups.map((g) => ({
        kind: "group" as const,
        id: g.id,
        platform: g.platform,
        connection: g.connectionId,
        name: g.name,
        access: g.access,
        updatedAt: 0,
      })),
    ]);
  });

  /** Ask about new people and groups on every chat app, not only the public ones. */
  app.put("/v1/admin/agents/:id/ask-all", async (c) => {
    const { on } = await c.req.json<{ on?: unknown }>();
    mingle.setAskAll(c.req.param("id"), on === true);
    return c.json(agentView(mingle.agent(c.req.param("id"))));
  });

  /** The daily memory tidy-up (docs/spec.md 4.5), on by default. */
  app.put("/v1/admin/agents/:id/tidy", async (c) => {
    const { on } = await c.req.json<{ on?: unknown }>();
    mingle.setTidy(c.req.param("id"), on === true);
    return c.json(agentView(mingle.agent(c.req.param("id"))));
  });

  app.get("/v1/admin/agents/:id/work", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    // Open tasks, and the work its lines finished in the last day.
    const lines = store.lineTasks(agent.id, Date.now() - 86_400_000);
    const open = store.tasks(agent.id, false).filter((t) => !lines.some((l) => l.id === t.id));
    const tasks = [...open, ...lines]
      .filter((t) => t.status !== "closed")
      // Work under way first, oldest first; what finished today after it.
      .sort((a, b) => Number(a.status === "done") - Number(b.status === "done") || a.createdAt - b.createdAt)
      .map((t) => {
        const chat = t.fromChat ? store.chat(t.fromChat) : undefined;
        const platform = chat ? store.connection(chat.connectionId)?.platform : undefined;
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          line: t.lineState ? lineState(t) : null,
          summary: t.summary,
          progress: t.progress,
          error: t.lineError,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          from: chat ? { name: chat.name, platform } : null,
        };
      });
    return c.json({ tasks, reminders: store.reminders(agent.id) });
  });

  /** The owner stops a reminder; the agent hears it with its next input (docs/spec.md 4.6). */
  app.delete("/v1/admin/agents/:id/reminders/:reminderId", (c) => {
    mingle.cancelReminder(c.req.param("id"), c.req.param("reminderId"));
    return c.json({ ok: true });
  });

  /** The owner closes an open task. `changed` is false when it was already done or closed. */
  app.post("/v1/admin/agents/:id/tasks/:taskId/close", (c) =>
    c.json({ changed: mingle.closeTask(c.req.param("id"), c.req.param("taskId")) }),
  );

  /** Handoffs from another conversation (docs/spec.md 4.12). The body is the owner's text; never logged. */
  app.post("/v1/admin/agents/:id/handoffs", async (c) => {
    const body = await c.req.json<{ body?: unknown; via?: unknown }>();
    const via = body.via === "paste" ? "paste" : "command";
    const { handoff, name, state } = mingle.handoff(c.req.param("id"), body.body, via);
    return c.json({ handoff: handoffView(handoff), name, state });
  });

  app.get("/v1/admin/agents/:id/handoffs", (c) => {
    const limit = clamp(Number(c.req.query("limit") ?? 30), 1, 200);
    return c.json(mingle.handoffs(c.req.param("id"), limit).map(handoffView));
  });

  app.get("/v1/admin/agents/:id/handoff-prompt", (c) => c.json({ text: mingle.handoffPrompt(c.req.param("id")) }));

  app.post("/v1/admin/agents/:id/open-home", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    execFile(opener, [mingle.homeDir(agent)], () => {});
    return c.json({ ok: true });
  });

  /** The installed harness, or the reason it cannot serve an agent. */
  const requireHarness = async (id: string) => {
    const listed = (list: readonly HarnessInfo[]) => list.find((h) => h.id === id);
    // The list is cached; look again before refusing, in case it was just installed or updated.
    let found = listed(await mingle.availableHarnesses());
    if (!found || found.disabled) found = listed(await mingle.availableHarnesses(true));
    if (!found) throw new MingleError("harness_unavailable", `${id} is not installed here`);
    if (found.disabled) throw new MingleError(found.disabled.code, found.disabled.reason);
  };

  app.post("/v1/admin/agents", async (c) => {
    const body = await c.req.json<{ name: string; role?: string; harness: string; model?: string }>();
    await requireHarness(body.harness);
    return c.json(
      agentView(
        mingle.createAgent({
          name: body.name,
          role: body.role ?? "",
          harness: body.harness,
          model: body.model ?? null,
        }),
      ),
    );
  });

  app.get("/v1/admin/agents/:id", (c) => c.json(agentView(mingle.agent(c.req.param("id")))));

  app.patch("/v1/admin/agents/:id", async (c) => {
    const body = await c.req.json<{ name?: string; harness?: string; model?: string | null }>();
    // A model-only change still opens the session on the current harness.
    if (body.harness !== undefined || body.model !== undefined) {
      await requireHarness(body.harness ?? mingle.agent(c.req.param("id")).harness);
    }
    return c.json(agentView(await mingle.updateAgent(c.req.param("id"), body)));
  });

  /** The picture as the raw request body: PNG, JPEG or WebP, judged by its bytes. */
  app.put("/v1/admin/agents/:id/avatar", async (c) => {
    const id = c.req.param("id");
    mingle.agent(id);
    if (Number(c.req.header("content-length") ?? 0) > AVATAR_MAX_BYTES) {
      throw new MingleError("avatar_too_large", "use an image under 2 MB", 413);
    }
    const image = new Uint8Array(await c.req.arrayBuffer());
    return c.json(agentView(mingle.setAvatar(id, image)));
  });

  app.delete("/v1/admin/agents/:id/avatar", (c) => c.json(agentView(mingle.clearAvatar(c.req.param("id")))));

  app.put("/v1/admin/agents/:id/role", async (c) => {
    const { role } = await c.req.json<{ role: string }>();
    await mingle.setRole(c.req.param("id"), role ?? "");
    return c.json({ ok: true });
  });

  /**
   * The agent's environment variables (docs/spec.md 4.4). Write-only: the list has names and
   * whether a value is stored, never a value; PUT takes a value and returns none.
   */
  app.get("/v1/admin/agents/:id/env", async (c) => c.json(await mingle.envList(c.req.param("id"))));

  app.put("/v1/admin/agents/:id/env/:name", async (c) => {
    const body = await c.req.json<{ value?: unknown } | null>().catch(() => null);
    await mingle.setEnv(c.req.param("id"), c.req.param("name"), body?.value);
    return c.json({ ok: true });
  });

  app.delete("/v1/admin/agents/:id/env/:name", async (c) => {
    await mingle.deleteEnv(c.req.param("id"), c.req.param("name"));
    return c.json({ ok: true });
  });

  app.post("/v1/admin/agents/:id/stop", async (c) => c.json({ stopped: await mingle.stopAgent(c.req.param("id")) }));
  /** Start over in a new harness session; home, memory and messages stay (docs/spec.md 4.11). */
  app.post("/v1/admin/agents/:id/reset", async (c) => {
    await mingle.resetSession(c.req.param("id"));
    return c.json({ ok: true });
  });
  /** Plain text for someone helping: versions, brain, session, status. No message text or secrets. */
  app.get("/v1/admin/agents/:id/diagnostics", async (c) =>
    c.json({ text: await mingle.diagnostics(c.req.param("id")) }),
  );
  /** The same, wrapped in a prompt for a local agent to find the cause and file a GitHub issue. */
  app.get("/v1/admin/agents/:id/diagnosis-prompt", async (c) =>
    c.json({ text: await mingle.diagnosisPrompt(c.req.param("id")) }),
  );
  /** Pause and resume (docs/spec.md 4.11). Both are idempotent: `changed` is false when it already was. */
  app.post("/v1/admin/agents/:id/pause", async (c) => c.json({ changed: await mingle.pauseAgent(c.req.param("id")) }));
  app.post("/v1/admin/agents/:id/resume", async (c) =>
    c.json({ changed: await mingle.resumeAgent(c.req.param("id")) }),
  );

  /** Try again on messages the agent failed or did not answer: all of them, or `ids`. */
  app.post("/v1/admin/agents/:id/messages/retry", async (c) => {
    const body = await c.req.json<{ ids?: unknown } | null>().catch(() => null);
    if (body?.ids !== undefined && (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string"))) {
      throw new MingleError("invalid_message_ids", "provide ids as an array of message IDs", 400);
    }
    return c.json(mingle.retryMessages(c.req.param("id"), body?.ids as string[] | undefined));
  });

  /** Mark failed or unanswered messages as ignored: kept in activity, no longer needing the owner. */
  app.post("/v1/admin/agents/:id/messages/ignore", async (c) => {
    const body = await c.req.json<{ ids?: unknown } | null>().catch(() => null);
    if (!Array.isArray(body?.ids) || !body.ids.every((id) => typeof id === "string")) {
      throw new MingleError("invalid_message_ids", "provide ids as an array of message IDs", 400);
    }
    return c.json({ ignored: mingle.ignoreMessages(c.req.param("id"), body.ids) });
  });

  app.delete("/v1/admin/agents/:id", async (c) => {
    await mingle.deleteAgent(c.req.param("id"), c.req.query("removeHome") === "1");
    return c.json({ ok: true });
  });

  app.post("/v1/admin/agents/:id/connections", async (c) => {
    const body = await c.req.json<{ platform: Platform; credentials: Record<string, string> }>();
    const connection = await mingle.addConnection(c.req.param("id"), body.platform, body.credentials);
    return c.json({
      id: connection.id,
      platform: connection.platform,
      bot: connection.botName,
      state: connection.state,
    });
  });

  /** QR onboarding: start, then poll. The QR is rendered here so the console needs no encoder. */
  app.post("/v1/admin/agents/:id/onboarding", async (c) => {
    const { platform, connectionId, adding } = await c.req.json<{
      platform: Platform;
      connectionId?: string;
      /** Optional permissions to turn on while re-authorizing that bot. */
      adding?: PermissionId[];
    }>();
    const known: readonly PermissionId[] = ["group_messages", "bot_messages", "doc_comments", "member_profiles"];
    const session = mingle.startOnboarding(
      c.req.param("id"),
      platform,
      connectionId || undefined,
      (adding ?? []).filter((id) => known.includes(id)),
    );
    return c.json({ id: session.id });
  });

  app.get("/v1/admin/onboarding/:id", async (c) => {
    const session = mingle.onboarding(c.req.param("id"));
    if (!session) throw new MingleError("onboarding_not_found", "start connecting again", 404);
    const state = session.state;
    if (state.kind === "qr") {
      const svg = await QRCode.toString(state.content, { type: "svg", margin: 0, errorCorrectionLevel: "M" });
      return c.json({ state: "qr", qrSvg: svg, url: state.content, expiresAt: state.expiresAt });
    }
    return c.json({ ...state, state: state.kind });
  });

  app.post("/v1/admin/onboarding/:id/code", async (c) => {
    const session = mingle.onboarding(c.req.param("id"));
    if (!session) throw new MingleError("onboarding_not_found", "start connecting again", 404);
    const { code } = await c.req.json<{ code: string }>();
    if (!session.submitCode) throw new MingleError("code_not_expected", "the chat app is not waiting for a code");
    if (!code?.trim()) throw new MingleError("code_required", "type the code shown on your phone");
    session.submitCode(code.trim());
    session.state = { kind: "scanned" };
    return c.json({ ok: true });
  });

  app.delete("/v1/admin/onboarding/:id", (c) => {
    mingle.cancelOnboarding(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Try an offline bot again now, rather than at its next automatic attempt.
  app.post("/v1/admin/connections/:id/reconnect", async (c) => {
    if (!store.connection(c.req.param("id"))) throw notFound("connection", c.req.param("id"));
    await mingle.reconnect(c.req.param("id"));
    const connection = store.connection(c.req.param("id"));
    return c.json({ state: connection?.state ?? null, detail: connection?.stateDetail ?? null });
  });

  /** A fresh claim code for a bot that has no owner yet; the old one stops working. */
  app.post("/v1/admin/connections/:id/claim", (c) => {
    if (!store.connection(c.req.param("id"))) throw notFound("connection", c.req.param("id"));
    return c.json(mingle.issueClaim(c.req.param("id")));
  });

  /**
   * What the owner can still grant this bot on the platform, read live (docs/spec.md 4.2). Empty
   * while the bot is offline or the platform has nothing to grant.
   */
  app.get("/v1/admin/connections/:id/permissions", async (c) => {
    if (!store.connection(c.req.param("id"))) throw notFound("connection", c.req.param("id"));
    const live = mingle.liveConnection(c.req.param("id"));
    const permissions = (await live?.permissions?.().catch(() => [])) ?? [];
    return c.json({ permissions });
  });

  app.delete("/v1/admin/connections/:id", async (c) => {
    if (!store.connection(c.req.param("id"))) throw notFound("connection", c.req.param("id"));
    await mingle.removeConnection(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}

async function accessBody(c: { req: { json<T>(): Promise<T> } }): Promise<"allowed" | "blocked"> {
  const { access } = await c.req.json<{ access?: unknown }>();
  if (access !== "allowed" && access !== "blocked") {
    throw new MingleError("access_invalid", 'send { "access": "allowed" } or { "access": "blocked" }');
  }
  return access;
}

/** Relative file paths are relative to the agent's home, which is the harness's working directory. */
function resolveFiles(home: string, files: readonly string[] | undefined): string[] | undefined {
  if (!files?.length) return undefined;
  return files.map((f) => (isAbsolute(f) ? f : resolve(home, f)));
}

/** A handoff for the console: its text, where it came from, its size in bytes and whether the agent has it. */
function handoffView(h: Handoff) {
  return {
    id: h.id,
    body: h.body,
    via: h.via,
    state: h.state,
    size: Buffer.byteLength(h.body, "utf8"),
    createdAt: h.createdAt,
    deliveredAt: h.deliveredAt,
  };
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : min;
}

/** Serve the built console, if there is one. */
export function serveConsole(app: Hono<Env>): boolean {
  const candidates = [
    fileURLToPath(new URL("../web/", import.meta.url)), // dist/api → dist/web
    fileURLToPath(new URL("../../web/dist/", import.meta.url)), // src/api → web/dist
  ];
  const root = candidates.find((dir) => existsSync(resolve(dir, "index.html")));
  if (!root) return false;
  app.use("/assets/*", serveStatic({ root }));
  const index = serveStatic({ root, path: "index.html" });
  // Everything that is not the API is the single-page console.
  app.get("*", (c, next) => (c.req.path.startsWith("/v1/") ? next() : index(c, next)));
  return true;
}

export function listen(app: Hono<Env>, port: number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolveListen, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
      resolveListen({
        url: `http://127.0.0.1:${info.port}`,
        // Open keep-alive connections (an open console polls) would hold close() forever.
        close: () =>
          new Promise((r) => {
            server.close(() => r());
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
    server.on("error", reject);
  });
}

/** How a line's work reads to the owner: under way, waiting its turn, waiting for a reply, done, broken. */
function lineState(task: Task): "running" | "queued" | "waiting" | "done" | "error" | "stopped" {
  if (task.lineState === "error") return "error";
  if (task.lineState === "ended" || task.status === "closed") return "stopped";
  if (task.status === "done") return "done";
  if (task.lineState === "queued") return "queued";
  return task.lineState === "running" ? "running" : "waiting";
}

/** A JSON body as an object to read fields from: `null`, a list or a value reads as having none. */
function objectBody(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
