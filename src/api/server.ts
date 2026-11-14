import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import QRCode from "qrcode";
import type { CredentialField, OnboardingMethod, Platform } from "../channels/channel.ts";
import { contactAlias, MingleError, notFound } from "../core/errors.ts";
import { excerpt, formatMessage } from "../core/format.ts";
import { readRole } from "../core/home.ts";
import { renderManual } from "../core/manual.ts";
import type { Mingle } from "../core/mingle.ts";
import { nextFire, parseDuration } from "../core/schedule.ts";
import type { HarnessInfo } from "../harness/harness.ts";
import {
  type Agent,
  type Connection,
  type Contact,
  contactName,
  type Message,
  type TaskStatus,
} from "../store/store.ts";
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
    const contact =
      m.direction === "in" && m.senderId ? store.contactByPlatformId(chat.connectionId, m.senderId) : undefined;
    return formatMessage(m, chat, connection.platform, { ownerId: connection.ownerId, agentName: agent.name, contact });
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
    // The same guide the session opened with, so the variable names match what it can read.
    const names = mingle.options.harness.acceptsEnv?.(agent.harness) === false ? [] : store.envNames(agent.id);
    return c.text(
      renderManual(
        agent.name,
        readRole(mingle.homeDir(agent)),
        process.platform,
        names.map((v) => v.name),
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
    refuseIfStopped(agent);
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

  const contactView = (k: Contact & { platform: Platform; owner: boolean }) => ({
    id: k.id,
    platform: k.platform,
    name: contactName(k),
    platformName: k.name,
    alias: k.alias,
    owner: k.owner,
  });

  app.get("/v1/agent/contacts", (c) => c.json(store.agentContacts(c.get("agent").id).map(contactView)));

  app.patch("/v1/agent/contacts/:id", async (c) => {
    const agent = c.get("agent");
    const id = c.req.param("id");
    if (!store.agentContact(agent.id, id)) throw notFound("contact", id);
    const body = await c.req.json<{ name?: unknown }>();
    store.setContactAlias(id, contactAlias(body.name));
    const updated = store.agentContacts(agent.id).find((k) => k.id === id);
    return c.json(updated && contactView(updated));
  });

  app.get("/v1/agent/chats/:id/messages", (c) => {
    const agent = c.get("agent");
    const chat = store.agentChat(agent.id, c.req.param("id"));
    if (!chat) throw notFound("chat", c.req.param("id"));
    const limit = clamp(Number(c.req.query("limit") ?? 30), 1, 200);
    const around = c.req.query("around");
    const since = c.req.query("since");
    const messages = around
      ? store.chatAround(chat.id, around, limit)
      : since
        ? store.chatSince(chat.id, since, limit)
        : store.chatMessages(chat.id, limit, c.req.query("before"));
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

  const agentView = (agent: Agent) => {
    const connections = store.connections(agent.id);
    const shared = sharedOwners(connections);
    return {
      ...agent,
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
      })),
    };
  };

  /**
   * Connections whose owner is not the only one on that platform: two WeChat accounts scanned by two
   * people, say. There "you" would be two people, so the console names them instead.
   */
  const sharedOwners = (connections: readonly Connection[]): Set<string> =>
    new Set(
      connections
        .filter((n) => n.ownerId)
        .filter((n) => connections.some((o) => o.platform === n.platform && o.ownerId && o.ownerId !== n.ownerId))
        .map((n) => n.id),
    );

  /** Who owns this bot, as the console names them. */
  const ownerContact = (connectionId: string, ownerId: string | null) => {
    if (!ownerId) return null;
    const contact = store.contactByPlatformId(connectionId, ownerId);
    return contact ? { id: contact.id, name: contactName(contact) } : null;
  };

  const inviteUrl = (platform: Platform, botId: string | null, botName: string | null): string | null => {
    if (!botId) return null;
    try {
      return mingle.channel(platform).inviteUrl?.({ id: botId, name: botName ?? "" }) ?? null;
    } catch {
      return null;
    }
  };

  app.get("/v1/admin/status", (c) => c.json({ version: VERSION, agents: store.agents().map(agentView) }));

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
        const installJob = mingle.brains.activeInstall(brain.id);
        return { ...brain, ...(installJob ? { installJob } : {}) };
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
    const all: Platform[] = ["wechat", "wecom", "feishu", "dingtalk", "qq", "slack", "discord", "telegram", "imessage"];
    // Channels that exist only on some systems (iMessage on macOS) are left out elsewhere, not shown as "soon".
    const local: readonly Platform[] = ["imessage"];
    return c.json(
      all
        .filter((platform) => !local.includes(platform) || mingle.hasChannel(platform))
        .map((platform) => {
          let onboarding: OnboardingMethod | null = null;
          let manualFields: readonly CredentialField[] = [];
          try {
            const channel = mingle.channel(platform);
            onboarding = channel.onboarding;
            manualFields = channel.manualFields ?? [];
          } catch {}
          return { platform, onboarding, manualFields };
        }),
    );
  });

  app.get("/v1/admin/agents/:id/activity", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const limit = clamp(Number(c.req.query("limit") ?? 30), 1, 200);
    const connections = store.connections(agent.id);
    const owners = new Set(connections.map((n) => `${n.id}:${n.ownerId}`));
    const shared = sharedOwners(connections);
    return c.json(
      store.agentActivity(agent.id, limit).map((m) => {
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
          contactId: contact?.id ?? null,
          body: m.body,
          state: m.state,
          /** While waiting for a passing failure: when Mingle tries it again. */
          retryAt: m.state === "waiting" ? (m.retryAt ?? null) : null,
          files: m.attachments.map((a) => a.name),
          createdAt: m.createdAt,
        };
      }),
    );
  });

  /** The owner names someone in the agent's address book, or clears the name with an empty one. */
  app.patch("/v1/admin/agents/:id/contacts/:contactId", async (c) => {
    const agent = mingle.agent(c.req.param("id"));
    const id = c.req.param("contactId");
    if (!store.agentContact(agent.id, id)) throw notFound("contact", id);
    const body = await c.req.json<{ name?: unknown }>();
    const contact = store.setContactAlias(id, contactAlias(body.name));
    return c.json({ id, name: contactName(contact) });
  });

  app.get("/v1/admin/agents/:id/work", (c) => {
    const agent = mingle.agent(c.req.param("id"));
    return c.json({ tasks: store.tasks(agent.id, false), reminders: store.reminders(agent.id) });
  });

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
  /** Pause and resume (docs/spec.md 4.11). Both are idempotent: `changed` is false when it already was. */
  app.post("/v1/admin/agents/:id/pause", async (c) => c.json({ changed: await mingle.pauseAgent(c.req.param("id")) }));
  app.post("/v1/admin/agents/:id/resume", async (c) =>
    c.json({ changed: await mingle.resumeAgent(c.req.param("id")) }),
  );

  /** Try again on messages the agent failed or did not answer: all of them, or `ids`. */
  app.post("/v1/admin/agents/:id/messages/retry", async (c) => {
    const body = await c.req.json<{ ids?: string[] }>().catch(() => ({}) as { ids?: string[] });
    return c.json(mingle.retryMessages(c.req.param("id"), body.ids));
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
    const { platform } = await c.req.json<{ platform: Platform }>();
    const session = mingle.startOnboarding(c.req.param("id"), platform);
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
