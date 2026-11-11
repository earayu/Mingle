#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { resolvePaths } from "../core/paths.ts";
import { VERSION } from "../version.ts";

/**
 * One command, two audiences:
 * - an agent inside its session (MINGLE_TOKEN set): message, chat, file, task, reminder, whoami, manual;
 * - the owner in a terminal: start, status, agent, connect, disconnect, harnesses.
 */

class CliError extends Error {
  readonly code: string;
  readonly next: string;
  constructor(code: string, next: string) {
    super(code);
    this.code = code;
    this.next = next;
  }
}

const OPTIONS = {
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  file: { type: "string", multiple: true },
  to: { type: "string" },
  limit: { type: "string" },
  before: { type: "string" },
  in: { type: "string" },
  out: { type: "string" },
  from: { type: "string" },
  all: { type: "boolean" },
  status: { type: "string" },
  at: { type: "string" },
  every: { type: "string" },
  chat: { type: "string" },
  name: { type: "string" },
  harness: { type: "string" },
  model: { type: "string" },
  role: { type: "string" },
  "role-file": { type: "string" },
  "remove-home": { type: "boolean" },
  port: { type: "string" },
} as const;

type Flags = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

// ------------------------------------------------------------------- client

async function request<T>(base: string, token: string, method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new CliError("mingle_not_running", 'Mingle is not running. Start it with "mingle start"');
  }
  const type = response.headers.get("content-type") ?? "";
  const payload = type.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = payload as { error?: string; next?: string };
    throw new CliError(error.error ?? `http_${response.status}`, error.next ?? "unexpected response from Mingle");
  }
  return payload as T;
}

function agentClient() {
  const base = process.env.MINGLE_API;
  const token = process.env.MINGLE_TOKEN;
  if (!base || !token) {
    throw new CliError(
      "not_in_agent_session",
      "this command is for agents; it needs MINGLE_API and MINGLE_TOKEN, which Mingle sets in the agent's session",
    );
  }
  return <T>(method: string, path: string, body?: unknown) => request<T>(base, token, method, path, body);
}

function adminClient() {
  const paths = resolvePaths();
  if (!existsSync(paths.runtime)) {
    throw new CliError("mingle_not_running", 'Mingle is not running. Start it with "mingle start"');
  }
  const runtime = JSON.parse(readFileSync(paths.runtime, "utf8")) as { url: string; adminToken: string };
  return <T>(method: string, path: string, body?: unknown) =>
    request<T>(runtime.url, runtime.adminToken, method, path, body);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function need(value: string | undefined, code: string, next: string): string {
  if (!value) throw new CliError(code, next);
  return value;
}

// ------------------------------------------------------------------ output

let jsonMode = false;

function print(data: unknown, text: () => string): void {
  console.log(jsonMode ? JSON.stringify(data, null, 2) : text());
}

function time(ms: number | null): string {
  if (ms === null) return "-";
  const d = new Date(ms);
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

interface SendReport {
  messages: { id: string }[];
  state: "sent" | "uncertain";
  degraded: string[];
}

function sendText(report: SendReport): string {
  const ids = report.messages.map((m) => m.id).join(", ");
  const lines = [
    report.state === "sent"
      ? `sent ${ids}`
      : `uncertain ${ids}: the chat app did not confirm; check with "mingle message read" before resending`,
  ];
  const notes: Record<string, string> = {
    quote_dropped: "this chat app does not support quoting; sent as a plain message",
    files_dropped: "files were not sent",
    markdown_flattened: "formatting is shown as plain text here",
    text_split: "the text was long and went out as several messages",
  };
  for (const d of report.degraded) if (notes[d]) lines.push(`note: ${notes[d]}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------- commands

async function agentCommand(group: string, action: string | undefined, args: string[], flags: Flags): Promise<boolean> {
  const call = () => agentClient();
  const files = (flags.file ?? []).map((f) => resolve(f));
  switch (`${group} ${action ?? ""}`.trim()) {
    case "message reply": {
      const id = need(args[0], "message_id_required", "usage: mingle message reply <message-id> <<'MSG' ... MSG");
      const text = await readStdin();
      const report = await call()<SendReport>("POST", "/v1/agent/messages/reply", { messageId: id, text, files });
      print(report, () => sendText(report));
      return true;
    }
    case "message send": {
      const to = need(flags.to, "chat_required", "usage: mingle message send --to <chat-id> <<'MSG' ... MSG");
      const text = await readStdin();
      const report = await call()<SendReport>("POST", "/v1/agent/messages/send", { chatId: to, text, files });
      print(report, () => sendText(report));
      return true;
    }
    case "message read": {
      const chat = need(
        args[0],
        "chat_required",
        "usage: mingle message read <chat-id> [--limit 30] [--before <message-id>]",
      );
      const q = new URLSearchParams({ limit: flags.limit ?? "30", ...(flags.before ? { before: flags.before } : {}) });
      const messages = await call()<{ id: string; text: string }[]>("GET", `/v1/agent/chats/${chat}/messages?${q}`);
      print(messages, () => messages.map((m) => m.text).join("\n\n") || "no messages");
      return true;
    }
    case "message search": {
      const query = need(args.join(" "), "query_required", 'usage: mingle message search "words" [--in <chat-id>]');
      const q = new URLSearchParams({
        q: query,
        ...(flags.in ? { in: flags.in } : {}),
        ...(flags.limit ? { limit: flags.limit } : {}),
      });
      const messages = await call()<{ id: string; text: string }[]>("GET", `/v1/agent/messages/search?${q}`);
      print(messages, () => messages.map((m) => m.text).join("\n\n") || "no matches");
      return true;
    }
    case "chat list": {
      const chats = await call()<
        { id: string; platform: string; kind: string; name: string | null; lastAt: number | null }[]
      >("GET", "/v1/agent/chats");
      print(chats, () =>
        chats.length
          ? chats.map((c) => `${c.id}  ${c.platform}  ${c.kind}  ${c.name ?? "-"}  last ${time(c.lastAt)}`).join("\n")
          : "no chats yet: nobody has messaged you",
      );
      return true;
    }
    case "chat info": {
      const chat = need(args[0], "chat_required", "usage: mingle chat info <chat-id>");
      const info = await call()<{
        id: string;
        platform: string;
        kind: string;
        name: string | null;
        members: { name: string }[] | null;
      }>("GET", `/v1/agent/chats/${chat}`);
      print(info, () =>
        [
          `${info.id}  ${info.platform}  ${info.kind}  ${info.name ?? "-"}`,
          info.members
            ? `members: ${info.members.map((m) => m.name).join(", ")}`
            : "members: not available on this chat app",
        ].join("\n"),
      );
      return true;
    }
    case "file get": {
      const id = need(args[0], "file_id_required", "usage: mingle file get <file-id> [--out <path>]");
      const result = await call()<{ path: string; name: string }>("POST", `/v1/agent/files/${id}/download`, {
        ...(flags.out ? { to: resolve(flags.out) } : { dir: process.cwd() }),
      });
      print(result, () => `saved ${result.name} to ${result.path}`);
      return true;
    }
    case "task create": {
      const title = need(args.join(" "), "title_required", 'usage: mingle task create "title" [--from <message-id>]');
      const task = await call()<{ id: string; title: string }>("POST", "/v1/agent/tasks", { title, from: flags.from });
      print(task, () => `created ${task.id}: ${task.title}`);
      return true;
    }
    case "task list": {
      const tasks = await call()<{ id: string; title: string; status: string; fromChat: string | null }[]>(
        "GET",
        `/v1/agent/tasks${flags.all ? "?all=1" : ""}`,
      );
      print(tasks, () =>
        tasks.length
          ? tasks.map((t) => `${t.id}  ${t.status}  ${t.title}${t.fromChat ? `  (from ${t.fromChat})` : ""}`).join("\n")
          : "no open tasks",
      );
      return true;
    }
    case "task update": {
      const id = need(args[0], "task_id_required", "usage: mingle task update <task-id> --status done");
      const status = need(flags.status, "status_required", "pass --status todo|in_progress|done|closed");
      const task = await call()<{ id: string; status: string }>("PATCH", `/v1/agent/tasks/${id}`, { status });
      print(task, () => `${task.id} is now ${task.status}`);
      return true;
    }
    case "reminder set": {
      const text = need(
        args.join(" "),
        "text_required",
        'usage: mingle reminder set "text" --in 6h | --at <time> | --every daily@09:00',
      );
      const reminder = await call()<{ id: string; nextFireAt: number }>("POST", "/v1/agent/reminders", {
        text,
        in: flags.in,
        at: flags.at,
        every: flags.every,
        chat: flags.chat,
      });
      print(reminder, () => `set ${reminder.id}, next at ${time(reminder.nextFireAt)}`);
      return true;
    }
    case "reminder list": {
      const reminders = await call()<{ id: string; body: string; rule: string; nextFireAt: number }[]>(
        "GET",
        "/v1/agent/reminders",
      );
      print(reminders, () =>
        reminders.length
          ? reminders.map((r) => `${r.id}  ${time(r.nextFireAt)}  ${r.rule}  ${r.body}`).join("\n")
          : "no reminders",
      );
      return true;
    }
    case "reminder cancel": {
      const id = need(args[0], "reminder_id_required", "usage: mingle reminder cancel <reminder-id>");
      const result = await call()<unknown>("DELETE", `/v1/agent/reminders/${id}`);
      print(result, () => `cancelled ${id}`);
      return true;
    }
    case "whoami": {
      const me = await call()<{
        name: string;
        harness: string;
        home: string;
        connections: { platform: string; bot: string; state: string }[];
      }>("GET", "/v1/agent/whoami");
      print(me, () =>
        [
          `${me.name} (${me.harness})`,
          `home: ${me.home}`,
          ...me.connections.map((c) => `${c.platform}: ${c.bot} ${c.state}`),
        ].join("\n"),
      );
      return true;
    }
    case "manual": {
      console.log(await call()<string>("GET", "/v1/agent/manual"));
      return true;
    }
  }
  return false;
}

async function adminCommand(group: string, action: string | undefined, args: string[], flags: Flags): Promise<boolean> {
  // These two take a value, not a subcommand, as their first argument.
  if (group === "connect") {
    // mingle connect <agent> telegram   (bot token on standard input)
    const agent = need(action, "agent_required", "usage: echo $BOT_TOKEN | mingle connect <agent> telegram");
    const platform = args[0] ?? "telegram";
    if (platform !== "telegram") {
      throw new CliError("platform_unsupported", "only telegram can be connected from the command line for now");
    }
    const token = need(
      (await readStdin()).trim(),
      "token_required",
      "pass the bot token from @BotFather on standard input",
    );
    const connection = await adminClient()<{ id: string; bot: string; state: string }>(
      "POST",
      `/v1/admin/agents/${agent}/connections`,
      { platform, credentials: { token } },
    );
    print(
      connection,
      () =>
        `connected ${connection.bot} (${connection.id}). Send it a direct message from your own account to become its owner.`,
    );
    return true;
  }
  if (group === "disconnect") {
    const id = need(action, "connection_required", "usage: mingle disconnect <connection-id>");
    await adminClient()("DELETE", `/v1/admin/connections/${id}`);
    print({ ok: true }, () => "disconnected");
    return true;
  }
  switch (`${group} ${action ?? ""}`.trim()) {
    case "status": {
      const status = await adminClient()<{ version: string; agents: AgentView[] }>("GET", "/v1/admin/status");
      print(status, () =>
        status.agents.length
          ? status.agents.map(agentLine).join("\n")
          : 'no agents yet. Create one with "mingle agent create --name Alex --harness claude"',
      );
      return true;
    }
    case "harnesses": {
      const list = await adminClient()<{ id: string; name: string; version?: string }[]>("GET", "/v1/admin/harnesses");
      print(
        list,
        () =>
          list.map((h) => `${h.id}  ${h.name}  ${h.version ?? ""}`).join("\n") ||
          "no supported harness found on this computer",
      );
      return true;
    }
    case "agent create": {
      const name = need(
        flags.name,
        "name_required",
        "usage: mingle agent create --name Alex --harness claude [--role ...|--role-file path]",
      );
      const harness = need(
        flags.harness,
        "harness_required",
        'pass --harness; "mingle harnesses" lists what is installed',
      );
      const role = flags["role-file"] ? readFileSync(flags["role-file"], "utf8") : (flags.role ?? "");
      const agent = await adminClient()<AgentView>("POST", "/v1/admin/agents", {
        name,
        harness,
        model: flags.model,
        role,
      });
      print(agent, () => `created ${agent.name} (${agent.slug}), home ${agent.home}`);
      return true;
    }
    case "agent list": {
      const status = await adminClient()<{ agents: AgentView[] }>("GET", "/v1/admin/status");
      print(status.agents, () => status.agents.map(agentLine).join("\n") || "no agents");
      return true;
    }
    case "agent role": {
      const id = need(args[0], "agent_required", "usage: mingle agent role <agent> <<'ROLE' ... ROLE");
      const role = flags["role-file"] ? readFileSync(flags["role-file"], "utf8") : await readStdin();
      await adminClient()("PUT", `/v1/admin/agents/${id}/role`, { role });
      print({ ok: true }, () => "role updated; it applies from the next message");
      return true;
    }
    case "agent stop": {
      const id = need(args[0], "agent_required", "usage: mingle agent stop <agent>");
      const result = await adminClient()<{ stopped: boolean }>("POST", `/v1/admin/agents/${id}/stop`);
      print(result, () => (result.stopped ? "stopped" : "it was not working on anything"));
      return true;
    }
    case "agent delete": {
      const id = need(args[0], "agent_required", "usage: mingle agent delete <agent> [--remove-home]");
      await adminClient()("DELETE", `/v1/admin/agents/${id}${flags["remove-home"] ? "?removeHome=1" : ""}`);
      print({ ok: true }, () =>
        flags["remove-home"] ? "deleted, including its home directory" : "deleted; its home directory was kept",
      );
      return true;
    }
    case "start":
      await start(flags);
      return true;
  }
  return false;
}

interface AgentView {
  id: string;
  slug: string;
  name: string;
  harness: string;
  status: string;
  statusDetail: string | null;
  home: string;
  connections: { id: string; platform: string; bot: string | null; state: string; owner: boolean }[];
}

function agentLine(a: AgentView): string {
  const conns = a.connections.map(
    (c) => `${c.platform}:${c.bot ?? "?"} ${c.state}${c.owner ? "" : " (no owner yet)"} [${c.id}]`,
  );
  return [
    `${a.name} (${a.slug})  ${a.harness}  ${a.status}${a.statusDetail ? `: ${a.statusDetail}` : ""}`,
    ...conns.map((c) => `  ${c}`),
  ].join("\n");
}

// ------------------------------------------------------------------- start

async function start(flags: Flags): Promise<void> {
  const paths = resolvePaths();
  if (existsSync(paths.runtime)) {
    const runtime = JSON.parse(readFileSync(paths.runtime, "utf8")) as { url: string; pid: number };
    const alive = await fetch(`${runtime.url}/v1/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (alive)
      throw new CliError("already_running", `Mingle is already running at ${runtime.url} (pid ${runtime.pid})`);
  }
  const logFile = resolve(paths.logs, "mingle.log");
  const log = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    try {
      appendFileSync(logFile, `${stamped}\n`);
    } catch {}
  };
  // Loaded here so agent commands, which run often, do not pay for OAR and the server.
  const [{ createApi, listen }, { telegramChannel }, { Mingle }, { oarHarness }, { defaultSecrets }] =
    await Promise.all([
      import("../api/server.ts"),
      import("../channels/telegram/telegram.ts"),
      import("../core/mingle.ts"),
      import("../harness/harness.ts"),
      import("../platform/secrets.ts"),
    ]);
  const mingle = new Mingle({
    paths,
    harness: oarHarness(),
    channels: { telegram: telegramChannel() },
    secrets: defaultSecrets(resolve(paths.home, "secrets.json")),
    cliEntry: fileURLToPath(import.meta.url),
    log,
  });
  const app = createApi(mingle);
  const port = Number(flags.port ?? process.env.MINGLE_PORT ?? 7419);
  const server = await listen(app, port).catch(() => listen(app, 0));
  await mingle.start(server.url);
  writeFileSync(paths.runtime, JSON.stringify({ url: server.url, adminToken: mingle.adminToken, pid: process.pid }), {
    mode: 0o600,
  });
  log(`Mingle ${VERSION} listening on ${server.url}, data in ${paths.home}`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log("stopping");
    rmSync(paths.runtime, { force: true });
    await mingle.stop();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// -------------------------------------------------------------------- help

const HELP = `mingle ${VERSION}

For the owner:
  mingle start [--port 7419]               run Mingle in this terminal
  mingle status                            agents and their connections
  mingle harnesses                         harnesses installed on this computer
  mingle agent create --name <n> --harness <id> [--model <m>] [--role <text> | --role-file <path>]
  mingle agent role <agent>                replace ROLE.md from standard input
  mingle agent stop <agent>                stop what it is doing now
  mingle agent delete <agent> [--remove-home]
  mingle connect <agent> telegram          bot token on standard input
  mingle disconnect <connection-id>

For agents (inside a session):
  mingle message reply <msg> | send --to <chat> | read <chat> | search <words>
  mingle chat list | info <chat>
  mingle file get <file>
  mingle task create | list | update
  mingle reminder set | list | cancel
  mingle whoami | manual

Add --json for machine-readable output.`;

// -------------------------------------------------------------------- main

async function main(): Promise<void> {
  const { values: flags, positionals } = parse(process.argv.slice(2));
  jsonMode = Boolean(flags.json);
  if (flags.version) {
    console.log(VERSION);
    return;
  }
  const [group, action, ...rest] = positionals;
  if (!group || flags.help) {
    console.log(HELP);
    return;
  }
  if (await agentCommand(group, action, rest, flags)) return;
  if (await adminCommand(group, action, rest, flags)) return;
  throw new CliError("unknown_command", `"${positionals.join(" ")}" is not a mingle command; run "mingle --help"`);
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(`error: ${error.code}\nnext: ${error.next}`);
  } else if (error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")) {
    console.error(`error: invalid_arguments\nnext: ${error.message}; run "mingle --help"`);
  } else {
    console.error(`error: internal\nnext: ${(error as Error)?.message ?? error}`);
  }
  process.exitCode = 1;
});
