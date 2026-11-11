import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ScriptedTurn, scriptedRuntime } from "@botiverse/oar/testing";
import { createApi, listen } from "../src/api/server.ts";
import type {
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  InboundMessage,
  OutboundMessage,
} from "../src/channels/channel.ts";
import { Mingle } from "../src/core/mingle.ts";
import { resolvePaths } from "../src/core/paths.ts";
import { oarHarness } from "../src/harness/harness.ts";
import { memorySecrets } from "../src/platform/secrets.ts";

export const CLI_ENTRY = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

/** A chat app that lives in memory. Tests push inbound messages and inspect what was sent. */
export class FakeChannel implements Channel {
  readonly platform = "telegram" as const;
  readonly onboarding = { kind: "credentials" as const, fields: [] };
  readonly sent: (OutboundMessage & { platformId: string })[] = [];
  readonly acks: string[] = [];
  private events: ChannelEvents | undefined;
  private seq = 1000;

  async *onboard() {
    yield { kind: "succeeded" as const, credentials: { token: "fake" }, bot: { id: "bot1", name: "@alex_bot" } };
  }

  async connect(_credentials: unknown, events: ChannelEvents): Promise<ChannelConnection> {
    this.events = events;
    return {
      bot: { id: "bot1", name: "@alex_bot" },
      capabilities: () => ({
        quoteReply: true,
        reactions: true,
        typingIndicator: true,
        fileUpload: true,
        fileDownload: false,
        listMembers: false,
        maxTextLength: 4096,
      }),
      send: async (message) => {
        const platformId = String(this.seq++);
        this.sent.push({ ...message, platformId });
        return { kind: "sent", platformId };
      },
      acknowledge: async (_chat: ChatRef, id: string) => {
        this.acks.push(id);
      },
      setTyping: async () => {},
      download: async () => {},
      listMembers: async () => [],
      close: async () => {},
    };
  }

  /** Deliver a message as if it arrived from the platform. */
  receive(partial: Partial<InboundMessage> & { text: string }): InboundMessage {
    const message: InboundMessage = {
      platformId: String(this.seq++),
      chat: { platformId: "-100", kind: "group", name: "Weekend hikes" },
      sender: { id: "u1", name: "Zhang San", isBot: false },
      attachments: [],
      addressedToBot: true,
      sentAt: Date.now(),
      ...partial,
    };
    this.events?.onMessage(message);
    return message;
  }
}

/** Run the real `mingle` CLI the way an agent would, with the session's environment. */
export function runCli(
  env: Record<string, string>,
  args: string[],
  stdin = "",
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      env.MINGLE_CLI as string,
      args,
      { env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      },
    );
    child.stdin?.end(stdin);
  });
}

export async function until<T>(check: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface Rig {
  mingle: Mingle;
  url: string;
  /** Call the admin API as the console does. */
  admin(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  channel: FakeChannel;
  agentId: string;
  turns: { readonly input: string; readonly steered: string[] }[];
  close(): Promise<void>;
}

/** A full Mingle (store, runtime, HTTP API, CLI) with a scripted harness and a fake chat app. */
export async function rig(
  turn: (t: ScriptedTurn) => Promise<void>,
  options: { harness?: string; real?: boolean; coalesceMs?: number } = {},
): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "mingle-test-"));
  const channel = new FakeChannel();
  const turns: Rig["turns"] = [];
  const runtime = scriptedRuntime({
    id: "scripted",
    turn: async (t) => {
      // Read steered inputs live: a test may look before the script returns.
      turns.push({
        input: t.input,
        get steered() {
          return [...t.steered];
        },
      });
      await turn(t);
    },
  });
  const mingle = new Mingle({
    paths: resolvePaths(home),
    harness: options.real ? oarHarness() : oarHarness({ require: () => runtime }),
    channels: { telegram: channel },
    secrets: memorySecrets(),
    cliEntry: CLI_ENTRY,
    coalesceMs: options.coalesceMs ?? 150,
    reminderTickMs: 60_000,
    retryDelaysMs: [10],
  });
  const server = await listen(createApi(mingle), 0);
  await mingle.start(server.url);
  const agent = mingle.createAgent({
    name: "Alex",
    role: "You help a group of friends plan weekend hikes. Keep replies to one or two sentences.",
    harness: options.harness ?? "scripted",
  });
  await mingle.addConnection(agent.id, "telegram", { token: "fake" });
  return {
    mingle,
    url: server.url,
    channel,
    agentId: agent.id,
    async admin(method, path, body) {
      const response = await fetch(`${server.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${mingle.adminToken}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, json: await response.json().catch(() => null) };
    },
    turns,
    async close() {
      await mingle.stop();
      await server.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** Message IDs in a delivered input, in order. */
export const messageIds = (text: string) => [...text.matchAll(/\bmsg=(m\w+)/g)].map((m) => m[1] as string);
