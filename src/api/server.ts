import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { OnboardingMethod, Platform } from "../channels/channel.ts";
import { MingleError, notFound } from "../core/errors.ts";
import { formatMessage } from "../core/format.ts";
import { readRole } from "../core/home.ts";
import { renderManual } from "../core/manual.ts";
import type { Mingle } from "../core/mingle.ts";
import { nextFire, parseDuration } from "../core/schedule.ts";
import type { Agent, Message, TaskStatus } from "../store/store.ts";
import { VERSION } from "../version.ts";

type Env = { Variables: { agent: Agent } };

const TASK_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "done", "closed"];

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
    mingle.log(`api: ${error.stack ?? error.message}`);
    return c.json({ error: "internal", next: "this is a Mingle bug; check ~/.mingle/logs" }, 500);
  });

  app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION }));

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
    await next();
  });

  const render = (agent: Agent, m: Message) => {
    const chat = store.chat(m.chatId);
    const connection = chat && store.connection(chat.connectionId);
    if (!chat || !connection) return "";
    return formatMessage(m, chat, connection.platform, { ownerId: connection.ownerId, agentName: agent.name });
  };

  app.get("/v1/agent/whoami", (c) => {
    const agent = c.get("agent");
    const connections = store.connections(agent.id).map((n) => ({
      platform: n.platform,
      bot: n.botName,
      state: mingle.isLive(n.id) ? n.state : n.state === "connected" ? "reconnecting" : n.state,
    }));
    return c.json({ name: agent.name, harness: agent.harness, home: mingle.homeDir(agent), connections });
  });

  app.get("/v1/agent/manual", (c) => {
    const agent = c.get("agent");
    return c.text(renderManual(agent.name, readRole(mingle.homeDir(agent))));
  });

  app.post("/v1/agent/messages/reply", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{ messageId: string; text: string; files?: string[] }>();
    const original = store.agentMessage(agent.id, body.messageId);
    if (!original) throw notFound("message", body.messageId);
    const report = await mingle.outbox.send(agent.id, {
      chatId: original.chatId,
      text: body.text ?? "",
      replyTo: original.id,
      files: resolveFiles(mingle.homeDir(agent), body.files),
    });
    return c.json(report);
  });

  app.post("/v1/agent/messages/send", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{ chatId: string; text: string; files?: string[] }>();
    const report = await mingle.outbox.send(agent.id, {
      chatId: body.chatId,
      text: body.text ?? "",
      files: resolveFiles(mingle.homeDir(agent), body.files),
    });
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
      members = (await live.listMembers(ref)).map((m) => ({ id: m.id, name: m.name }));
    }
    return c.json({ id: chat.id, platform: connection?.platform, kind: chat.kind, name: chat.name, members });
  });

  app.get("/v1/agent/chats/:id/messages", (c) => {
    const agent = c.get("agent");
    const chat = store.agentChat(agent.id, c.req.param("id"));
    if (!chat) throw notFound("chat", c.req.param("id"));
    const limit = clamp(Number(c.req.query("limit") ?? 30), 1, 200);
    const messages = store.chatMessages(chat.id, limit, c.req.query("before"));
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
    return c.json(messages.map((m) => ({ id: m.id, text: render(agent, m) })));
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
    return c.json(store.tasks(agent.id, c.req.query("all") === "1"));
  });

  app.patch("/v1/agent/tasks/:id", async (c) => {
    const agent = c.get("agent");
    const { status } = await c.req.json<{ status: TaskStatus }>();
    if (!TASK_STATUSES.includes(status)) {
      throw new MingleError("invalid_status", `use one of: ${TASK_STATUSES.join(", ")}`);
    }
    const task = store.setTaskStatus(agent.id, c.req.param("id"), status);
    if (!task) throw notFound("task", c.req.param("id"));
    return c.json(task);
  });

  app.post("/v1/agent/reminders", async (c) => {
    const agent = c.get("agent");
    const body = await c.req.json<{ text: string; in?: string; at?: string; every?: string; chat?: string }>();
    if (!body.text?.trim())
      throw new MingleError(
        "text_required",
        'say what to be reminded of: mingle reminder set "Check the forecast" --in 6h',
      );
    if (body.chat && !store.agentChat(agent.id, body.chat)) throw notFound("chat", body.chat);
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
    const reminder = store.createReminder({
      agentId: agent.id,
      body: body.text.trim(),
      rule,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      chatId: body.chat ?? null,
      nextFireAt: next,
    });
    return c.json(reminder);
  });

  app.get("/v1/agent/reminders", (c) => c.json(store.reminders(c.get("agent").id)));

  app.delete("/v1/agent/reminders/:id", (c) => {
    if (!store.deleteReminder(c.get("agent").id, c.req.param("id"))) throw notFound("reminder", c.req.param("id"));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ admin

  app.use("/v1/admin/*", async (c, next) => {
    const token = c.req.header("authorization")?.replace(/^Bearer /, "");
    if (token !== mingle.adminToken)
      throw new MingleError("unauthorized", "admin token mismatch; is this the running Mingle?", 401);
    await next();
  });

  const agentView = (agent: Agent) => ({
    ...agent,
    home: mingle.homeDir(agent),
    role: readRole(mingle.homeDir(agent)),
    connections: store.connections(agent.id).map((n) => ({
      id: n.id,
      platform: n.platform,
      bot: n.botName,
      state: n.state,
      detail: n.stateDetail,
      owner: n.ownerId !== null,
    })),
  });

  app.get("/v1/admin/status", (c) => c.json({ version: VERSION, agents: store.agents().map(agentView) }));
  app.get("/v1/admin/harnesses", async (c) => c.json(await mingle.availableHarnesses()));

  /** Every first-batch platform, with how to connect it, or null when it is not built yet. */
  app.get("/v1/admin/platforms", (c) => {
    const all: Platform[] = ["wechat", "wecom", "feishu", "dingtalk", "qq", "slack", "discord", "telegram"];
    return c.json(
      all.map((platform) => {
        let onboarding: OnboardingMethod | null = null;
        try {
          onboarding = mingle.channel(platform).onboarding;
        } catch {}
        return { platform, onboarding };
      }),
    );
  });

  app.get("/v1/admin/agents/:id/activity", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const limit = clamp(Number(c.req.query("limit") ?? 30), 1, 200);
    return c.json(
      store.agentActivity(agent.id, limit).map((m) => ({
        id: m.id,
        direction: m.direction,
        platform: m.platform,
        chat: { id: m.chat.id, kind: m.chat.kind, name: m.chat.name },
        sender: m.direction === "in" ? (m.senderName ?? m.senderId) : agent.name,
        body: m.body,
        state: m.state,
        files: m.attachments.map((a) => a.name),
        createdAt: m.createdAt,
      })),
    );
  });

  app.get("/v1/admin/agents/:id/work", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    return c.json({ tasks: store.tasks(agent.id, false), reminders: store.reminders(agent.id) });
  });

  app.post("/v1/admin/agents/:id/open-home", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    execFile(opener, [mingle.homeDir(agent)], () => {});
    return c.json({ ok: true });
  });

  app.post("/v1/admin/agents", async (c) => {
    const body = await c.req.json<{ name: string; role?: string; harness: string; model?: string }>();
    const harnesses = await mingle.availableHarnesses();
    if (!harnesses.some((h) => h.id === body.harness)) {
      throw new MingleError(
        "harness_unavailable",
        `${body.harness} is not installed here. Available: ${harnesses.map((h) => h.id).join(", ") || "none"}`,
      );
    }
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

  app.put("/v1/admin/agents/:id/role", async (c) => {
    const { role } = await c.req.json<{ role: string }>();
    await mingle.setRole(c.req.param("id"), role ?? "");
    return c.json({ ok: true });
  });

  app.post("/v1/admin/agents/:id/stop", async (c) => c.json({ stopped: await mingle.stopAgent(c.req.param("id")) }));

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

  app.delete("/v1/admin/connections/:id", async (c) => {
    if (!store.connection(c.req.param("id"))) throw notFound("connection", c.req.param("id"));
    await mingle.removeConnection(c.req.param("id"));
    return c.json({ ok: true });
  });

  return app;
}

/** Relative file paths are relative to the agent's home, which is the harness's working directory. */
function resolveFiles(home: string, files: readonly string[] | undefined): string[] | undefined {
  if (!files?.length) return undefined;
  return files.map((f) => (isAbsolute(f) ? f : resolve(home, f)));
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
    server.on("error", reject);
  });
}
