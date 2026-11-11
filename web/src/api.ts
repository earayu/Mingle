/** Client for the admin API of the running Mingle. The token comes from the URL fragment `mingle open` puts there. */

const TOKEN_KEY = "mingle.token";

export function captureToken(): string | null {
  const match = /(?:^|&)token=([^&]+)/.exec(location.hash.slice(1));
  if (match?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, match[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

export class ApiError extends Error {
  readonly code: string;
  readonly next: string;
  readonly status: number;
  constructor(code: string, next: string, status: number) {
    super(next);
    this.code = code;
    this.next = next;
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) ?? ""}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("offline", "", 0);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload as { error?: string; next?: string };
    throw new ApiError(error.error ?? "http_error", error.next ?? response.statusText, response.status);
  }
  return payload as T;
}

export type AgentStatus = "offline" | "idle" | "thinking" | "working" | "error";
export type Platform = "wechat" | "wecom" | "feishu" | "dingtalk" | "qq" | "slack" | "discord" | "telegram";

export interface ConnectionView {
  id: string;
  platform: Platform;
  bot: string | null;
  state: "awaiting_credentials" | "awaiting_approval" | "connected" | "reconnecting" | "error";
  detail: string | null;
  owner: boolean;
}

export interface AgentView {
  id: string;
  slug: string;
  name: string;
  harness: string;
  model: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  home: string;
  role: string;
  connections: ConnectionView[];
}

export interface Activity {
  id: string;
  direction: "in" | "out";
  platform: Platform;
  chat: { id: string; kind: "dm" | "group" | "thread"; name: string | null };
  sender: string | null;
  body: string;
  state: string;
  files: string[];
  createdAt: number;
}

export interface Harness {
  id: string;
  name: string;
  version?: string;
}

export interface PlatformInfo {
  platform: Platform;
  onboarding:
    | { kind: "qr" }
    | { kind: "credentials"; fields: { key: string; labelKey: string; secret: boolean }[] }
    | null;
}

export interface Task {
  id: string;
  title: string;
  status: string;
}

export interface Reminder {
  id: string;
  body: string;
  rule: string;
  nextFireAt: number | null;
}

export const api = {
  status: () => call<{ version: string; agents: AgentView[] }>("GET", "/v1/admin/status"),
  harnesses: () => call<Harness[]>("GET", "/v1/admin/harnesses"),
  platforms: () => call<PlatformInfo[]>("GET", "/v1/admin/platforms"),
  createAgent: (input: { name: string; role: string; harness: string; model?: string }) =>
    call<AgentView>("POST", "/v1/admin/agents", input),
  setRole: (id: string, role: string) => call("PUT", `/v1/admin/agents/${id}/role`, { role }),
  stop: (id: string) => call<{ stopped: boolean }>("POST", `/v1/admin/agents/${id}/stop`),
  remove: (id: string) => call("DELETE", `/v1/admin/agents/${id}`),
  openHome: (id: string) => call("POST", `/v1/admin/agents/${id}/open-home`),
  activity: (id: string) => call<Activity[]>("GET", `/v1/admin/agents/${id}/activity?limit=30`),
  work: (id: string) => call<{ tasks: Task[]; reminders: Reminder[] }>("GET", `/v1/admin/agents/${id}/work`),
  connect: (id: string, platform: Platform, credentials: Record<string, string>) =>
    call<{ id: string }>("POST", `/v1/admin/agents/${id}/connections`, { platform, credentials }),
  disconnect: (connectionId: string) => call("DELETE", `/v1/admin/connections/${connectionId}`),
};
