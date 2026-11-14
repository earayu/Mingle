import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Store } from "../store/store.ts";
import { localTime, renderMessage } from "./format.ts";

/**
 * Cold start (docs/spec.md 4.1): a long session that sat idle past the prompt cache's lifetime
 * would rewrite its whole history into the cache on the next turn. Instead, a fresh session opens
 * and its first input is a small one Mingle builds from what the agent needs: the start of
 * MEMORY.md, the latest conversation, the files it just changed, its last actions and the input
 * that woke it. Borrowed from Raft's constructed initial context.
 */

/** Idle this long and the prompt cache is gone (Claude's longest cache lifetime is one hour). */
export const COLD_IDLE_MS = 3_600_000;
/** Below this many tokens of context a cold resume is cheap enough to keep. */
export const COLD_MIN_TOKENS = 128_000;
/** About 4K tokens: bytes, so Chinese (about one token a character, three bytes) stays near it too. */
export const MEMORY_HEAD_BYTES = 16 * 1024;
export const RECENT_MESSAGES = 25;
export const RECENT_FILES_MS = 2 * 3_600_000;
const MAX_FILES = 40;
export const RECENT_ACTIONS = 15;
/** Characters kept of one action's detail, and of one message body. */
const ACTION_CHARS = 160;
const MESSAGE_CHARS = 1200;

export interface ColdPolicy {
  readonly idleMs: number;
  readonly minTokens: number;
}

export const DEFAULT_COLD_POLICY: ColdPolicy = { idleMs: COLD_IDLE_MS, minTokens: COLD_MIN_TOKENS };

/**
 * The dev flag that turns cold starts on while they are measured (docs/spec.md 12):
 * `MINGLE_COLD_START=rebuild` for every agent, or a comma-separated list of agent ids or slugs.
 * Unset, or anything else, keeps resuming.
 */
export function coldRebuildFor(
  flag: string | undefined,
  agent: { readonly id: string; readonly slug: string },
): boolean {
  const value = flag?.trim();
  if (!value) return false;
  if (value === "rebuild") return true;
  return value
    .split(",")
    .map((v) => v.trim())
    .some((v) => v === agent.id || v === agent.slug);
}

/**
 * Whether the next input meets a cold session: nothing running (an interjection steers into the
 * warm turn instead), idle past the cache's lifetime, and a context large enough that rewriting it
 * costs more than starting over. `tokens` is null when the harness has not reported it.
 */
export function isCold(
  state: { readonly running: boolean; readonly idleSince: number; readonly tokens: number | null },
  now: number,
  policy: ColdPolicy = DEFAULT_COLD_POLICY,
): boolean {
  if (state.running || state.tokens === null) return false;
  return now - state.idleSince > policy.idleMs && state.tokens > policy.minTokens;
}

/** One thing the agent did: a tool call, as the harness reported it. */
export interface Action {
  readonly at: number;
  readonly text: string;
}

/** The fields of a tool call's input worth showing, in order of preference. */
const INPUT_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"];

/** A tool call in one line: `Bash: pnpm test`. The input is often JSON; its telling field is kept. */
export function describeAction(tool: string, input?: string): string {
  let detail = input?.trim() ?? "";
  if (detail.startsWith("{")) {
    try {
      const value = JSON.parse(detail) as Record<string, unknown>;
      const key = INPUT_KEYS.find((k) => typeof value[k] === "string" && value[k]);
      detail = key ? String(value[key]) : "";
    } catch {
      // Not JSON after all: keep the text.
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if ([...detail].length > ACTION_CHARS) detail = `${[...detail].slice(0, ACTION_CHARS).join("")}…`;
  return detail ? `${tool}: ${detail}` : tool;
}

/** The first `bytes` of MEMORY.md, cut at a line end; empty when there is none. */
export function memoryHead(homeDir: string, bytes = MEMORY_HEAD_BYTES): { text: string; cut: boolean } {
  let fd: number;
  try {
    fd = openSync(join(homeDir, "MEMORY.md"), "r");
  } catch {
    return { text: "", cut: false };
  }
  try {
    const size = statSync(join(homeDir, "MEMORY.md")).size;
    const buffer = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buffer, 0, buffer.length, 0);
    if (size <= bytes) return { text: buffer.toString("utf8").trimEnd(), cut: false };
    const text = buffer.toString("utf8");
    const end = text.lastIndexOf("\n");
    // A cut mid-character decodes to U+FFFD; cutting at the last full line drops it.
    return { text: (end > 0 ? text.slice(0, end) : text.replace(/�+$/u, "")).trimEnd(), cut: true };
  } finally {
    closeSync(fd);
  }
}

/** Folders in a home that are tooling, not the agent's work. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".codex", ".cursor", ".venv", "__pycache__"]);

/** Files under `homeDir` changed since `since`, newest first, as paths relative to it. */
export function recentFiles(homeDir: string, since: number, limit = MAX_FILES): string[] {
  const found: { path: string; at: number }[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || visited > 5000) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      visited++;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path, depth + 1);
      } else if (entry.isFile()) {
        try {
          const at = statSync(path).mtimeMs;
          if (at >= since) found.push({ path: relative(homeDir, path), at });
        } catch {
          // Gone between listing and stat.
        }
      }
    }
  };
  walk(homeDir, 0);
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map((f) => f.path);
}

/**
 * The context that opens a fresh session, as separate blocks, before the input that woke the agent.
 * It reads as an ordinary briefing: it does not say the session was replaced, and asks for no
 * summary. Blocks with nothing in them are left out. `exclude`: the messages being delivered now,
 * which follow this context anyway.
 */
export function buildColdContext(input: {
  readonly store: Store;
  readonly agentId: string;
  readonly agentName: string;
  readonly homeDir: string;
  readonly actions: readonly Action[];
  readonly exclude: readonly string[];
  readonly now: number;
}): string {
  const { store } = input;
  const blocks: string[] = [];

  const memory = memoryHead(input.homeDir);
  if (memory.text) {
    blocks.push(`## MEMORY.md${memory.cut ? " (its start; read the file for the rest)" : ""}\n\n${memory.text}`);
  }

  const messages = store
    .recentConversation(input.agentId, RECENT_MESSAGES, input.exclude)
    .map((m) => {
      const body = [...m.body];
      // Say where the rest is: the spike showed a cut message is otherwise taken as all there is.
      const rest = `[cut here; the full text: "$MINGLE_CLI" message read ${m.chatId} --around ${m.id}]`;
      const message =
        body.length > MESSAGE_CHARS ? { ...m, body: `${body.slice(0, MESSAGE_CHARS).join("")}…\n${rest}` } : m;
      return renderMessage(store, message, { agentName: input.agentName });
    })
    .filter(Boolean);
  if (messages.length > 0) {
    blocks.push(
      `## Latest messages across your chats (oldest first; \`message read\` for more)\n\n${messages.join("\n\n")}`,
    );
  }

  const files = recentFiles(input.homeDir, input.now - RECENT_FILES_MS);
  if (files.length > 0) {
    blocks.push(`## Files in your home folder changed in the last 2 hours\n\n${files.map((f) => `- ${f}`).join("\n")}`);
  }

  const actions = input.actions.slice(-RECENT_ACTIONS);
  if (actions.length > 0) {
    blocks.push(`## Your last actions\n\n${actions.map((a) => `- ${localTime(a.at)} ${a.text}`).join("\n")}`);
  }

  if (blocks.length === 0) return "";
  return `[mingle] Where things stand, before the new input below.\n\n${blocks.join("\n\n")}\n\n## New input`;
}
