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

export type AgentStatus = "offline" | "idle" | "thinking" | "working" | "error" | "paused";
export type Platform =
  | "wechat"
  | "wecom"
  | "feishu"
  | "dingtalk"
  | "qq"
  | "slack"
  | "discord"
  | "telegram"
  | "imessage";

export interface ConnectionView {
  id: string;
  platform: Platform;
  bot: string | null;
  state: "awaiting_credentials" | "awaiting_approval" | "connected" | "reconnecting" | "error";
  detail: string | null;
  /** When Mingle tries an offline bot again by itself; null when it waits for the person or is connected. */
  retryAt: number | null;
  owner: boolean;
  /** The owner as the agent's address book names them; name is null until someone names them. */
  ownerContact: { id: string; name: string | null } | null;
  /** Another bot on this platform has a different owner, so this one's owner needs a name. */
  ownerShared: boolean;
  /** Where to add the bot to a server, for platforms where that is a separate step. */
  invite: string | null;
}

export interface AgentView {
  id: string;
  slug: string;
  name: string;
  harness: string;
  model: string | null;
  status: AgentStatus;
  statusDetail: string | null;
  /** With status "error": auth, quota, billing, model_unavailable, ... or null when unknown. */
  statusFailure: string | null;
  /** Whether this agent has ever successfully sent a message. */
  hasReplied: boolean;
  /** The harness's display name ("Claude Code"). */
  harnessName: string;
  home: string;
  role: string;
  connections: ConnectionView[];
}

export interface Activity {
  id: string;
  direction: "in" | "out";
  triggers: boolean;
  platform: Platform;
  chat: { id: string; kind: "dm" | "group" | "thread"; name: string | null };
  sender: string | null;
  senderIsOwner: boolean;
  /** An owner, and the only one on this platform: an unnamed one can be called "you". */
  senderIsOnlyOwner: boolean;
  contactId: string | null;
  body: string;
  state: string;
  /** While waiting for a passing failure: when Mingle tries it again. */
  retryAt: number | null;
  files: string[];
  createdAt: number;
}

export interface Harness {
  id: string;
  name: string;
  version?: string;
  icon?: { light: string; dark: string };
  /** Listed but cannot serve Mingle: what is missing and the next step. */
  disabled?: { code: string; reason: string };
  /** Its shell gets no environment, so the agent's variables do not reach it. */
  noEnv?: true;
}

/** An agent's environment variable: its name only. Values are write-only. */
export interface EnvVar {
  name: string;
  updatedAt: number;
  /** The name is known but the system credential store no longer has its value. */
  missing: boolean;
}

export interface Model {
  id: string;
  name: string;
  isDefault?: boolean;
  provider?: string;
  disabled?: string;
}

export interface BrainStatus extends Harness {
  installed: boolean;
  unsupported?: string;
  canInstall: boolean;
  canSignIn: boolean;
  /** An installation still running in the local Mingle process. */
  installJob?: Job;
}

export type SignInState =
  | { kind: "signed_in"; account?: string; plan?: string }
  | { kind: "signed_out"; detail?: string }
  | { kind: "unknown" };

export type InstallPlan =
  | { kind: "plan"; steps: string[]; source: string }
  | { kind: "unsupported"; detail: string; steps?: string[]; source?: string };

export interface Job {
  id: string;
  kind: "install" | "sign_in";
  harness: string;
  state: "running" | "done" | "failed" | "cancelled";
  events: (
    | { kind: "url"; url: string; instructions?: string }
    | { kind: "code"; code: string; url: string }
    | { kind: "info"; message: string }
  )[];
  prompt?: { message: string; secret: boolean; options?: { id: string; label: string }[] };
  detail?: string;
}

export type ModelList = { kind: "ok"; models: Model[] } | { kind: "unauthenticated" } | { kind: "unsupported" };

export interface CredentialField {
  key: string;
  labelKey: string;
  secret: boolean;
}

export interface PlatformInfo {
  platform: Platform;
  onboarding:
    | { kind: "qr"; desktopLink?: boolean }
    | { kind: "credentials"; fields: CredentialField[]; setupUrl?: string }
    | null;
  manualFields: CredentialField[];
}

export type OnboardingState =
  | { state: "starting" }
  | { state: "qr"; qrSvg: string; url: string; expiresAt: number }
  | { state: "scanned" }
  | { state: "awaiting_approval" }
  | { state: "needs_code"; retry: boolean }
  | { state: "done"; connectionId: string; pendingApproval: boolean }
  | { state: "failed"; code: string };

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
  /** The last catalog Mingle found at once; `fresh` probes every harness again, a second or more. */
  brains: (fresh = false) => call<BrainStatus[]>("GET", `/v1/admin/brains${fresh ? "?fresh=1" : ""}`),
  signInState: (harness: string) => call<SignInState>("GET", `/v1/admin/brains/${harness}/sign-in`),
  installPlan: (harness: string) => call<InstallPlan>("GET", `/v1/admin/brains/${harness}/install-plan`),
  install: (harness: string) => call<Job>("POST", `/v1/admin/brains/${harness}/install`),
  signIn: (harness: string) => call<Job>("POST", `/v1/admin/brains/${harness}/sign-in`),
  job: (id: string) => call<Job>("GET", `/v1/admin/jobs/${id}`),
  answerJob: (id: string, value: string) => call("POST", `/v1/admin/jobs/${id}/answer`, { value }),
  cancelJob: (id: string) => call("DELETE", `/v1/admin/jobs/${id}`),
  models: (harness: string) => call<ModelList>("GET", `/v1/admin/harnesses/${harness}/models`),
  updateAgent: (id: string, patch: { name?: string; harness?: string; model?: string | null }) =>
    call<AgentView>("PATCH", `/v1/admin/agents/${id}`, patch),
  platforms: () => call<PlatformInfo[]>("GET", "/v1/admin/platforms"),
  createAgent: (input: { name: string; role: string; harness: string; model?: string }) =>
    call<AgentView>("POST", "/v1/admin/agents", input),
  setRole: (id: string, role: string) => call("PUT", `/v1/admin/agents/${id}/role`, { role }),
  env: (id: string) => call<EnvVar[]>("GET", `/v1/admin/agents/${id}/env`),
  setEnv: (id: string, name: string, value: string) =>
    call("PUT", `/v1/admin/agents/${id}/env/${encodeURIComponent(name)}`, { value }),
  deleteEnv: (id: string, name: string) => call("DELETE", `/v1/admin/agents/${id}/env/${encodeURIComponent(name)}`),
  stop: (id: string) => call<{ stopped: boolean }>("POST", `/v1/admin/agents/${id}/stop`),
  /** Stop taking messages until resumed; ends the work in hand (docs/spec.md 4.11). */
  pause: (id: string) => call<{ changed: boolean }>("POST", `/v1/admin/agents/${id}/pause`),
  resume: (id: string) => call<{ changed: boolean }>("POST", `/v1/admin/agents/${id}/resume`),
  /** Start over in a new harness session; home, memory and messages stay. */
  resetSession: (id: string) => call<{ ok: true }>("POST", `/v1/admin/agents/${id}/reset`),
  /** Plain text to share when asking for help: versions, brain, session, status. */
  diagnostics: (id: string) => call<{ text: string }>("GET", `/v1/admin/agents/${id}/diagnostics`),
  /** Try again on failed or unanswered messages: these, or all of them. */
  retry: (id: string, ids?: string[]) =>
    call<{ retried: string[]; offline: string[] }>("POST", `/v1/admin/agents/${id}/messages/retry`, ids ? { ids } : {}),
  /** Dismiss these failed or unanswered messages without sending anything. */
  ignore: (id: string, ids: string[]) =>
    call<{ ignored: string[] }>("POST", `/v1/admin/agents/${id}/messages/ignore`, { ids }),
  remove: (id: string) => call("DELETE", `/v1/admin/agents/${id}`),
  openHome: (id: string) => call("POST", `/v1/admin/agents/${id}/open-home`),
  /** Name someone in the agent's address book; an empty name clears it. */
  nameContact: (id: string, contactId: string, name: string) =>
    call<{ id: string; name: string | null }>("PATCH", `/v1/admin/agents/${id}/contacts/${contactId}`, { name }),
  activity: (id: string) => call<Activity[]>("GET", `/v1/admin/agents/${id}/activity?limit=30`),
  work: (id: string) => call<{ tasks: Task[]; reminders: Reminder[] }>("GET", `/v1/admin/agents/${id}/work`),
  connect: (id: string, platform: Platform, credentials: Record<string, string>) =>
    call<{ id: string }>("POST", `/v1/admin/agents/${id}/connections`, { platform, credentials }),
  disconnect: (connectionId: string) => call("DELETE", `/v1/admin/connections/${connectionId}`),
  /** Try an offline bot again now. */
  reconnect: (connectionId: string) => call("POST", `/v1/admin/connections/${connectionId}/reconnect`),
  startOnboarding: (id: string, platform: Platform) =>
    call<{ id: string }>("POST", `/v1/admin/agents/${id}/onboarding`, { platform }),
  onboarding: (id: string) => call<OnboardingState>("GET", `/v1/admin/onboarding/${id}`),
  cancelOnboarding: (id: string) => call("DELETE", `/v1/admin/onboarding/${id}`),
  submitCode: (id: string, code: string) => call("POST", `/v1/admin/onboarding/${id}/code`, { code }),
};
