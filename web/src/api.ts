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

const MAX_ETAG_CACHE = 128;
const etagCache = new Map<string, { etag: string; value: unknown }>();

export function clearResponseCache(): void {
  etagCache.clear();
}

async function call<T>(method: string, path: string, body?: unknown, remote?: string): Promise<T> {
  if (remote) path = `/v1/admin/ssh/${remote}/${path.slice("/v1/admin/".length)}`;
  let response: Response;
  // Raw bytes (a picture) go as they are; everything else is JSON.
  const raw = body instanceof Blob;
  const token = sessionStorage.getItem(TOKEN_KEY) ?? "";
  const cacheKey = method === "GET" ? `${token}\0${path}` : null;
  const cached = cacheKey ? etagCache.get(cacheKey) : undefined;
  try {
    response = await fetch(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(cached ? { "if-none-match": cached.etag } : {}),
        ...(body !== undefined ? { "content-type": raw ? body.type : "application/json" } : {}),
      },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("offline", "", 0);
  }
  if (response.status === 304 && cached) {
    // Refresh recency and return the exact previous object reference so React skips re-renders.
    etagCache.delete(cacheKey as string);
    etagCache.set(cacheKey as string, cached);
    return cached.value as T;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) etagCache.clear();
    const error = payload as { error?: string; next?: string };
    throw new ApiError(error.error ?? "http_error", error.next ?? response.statusText, response.status);
  }
  if (cacheKey) {
    const etag = response.headers.get("etag");
    if (etag) {
      etagCache.delete(cacheKey);
      if (etagCache.size >= MAX_ETAG_CACHE) {
        const oldest = etagCache.keys().next().value;
        if (oldest !== undefined) etagCache.delete(oldest);
      }
      etagCache.set(cacheKey, { etag, value: payload });
    }
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
  | "imessage"
  | "github"
  /** The owner's private chat in the console (docs/spec.md 6.9): built in, never a chat app in the lists. */
  | "local";

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
  /**
   * Who can reach the bot (docs/spec.md 4.7): `org` only people in the organization, `public`
   * anyone who finds it, `owner` only the owner (it is their own account).
   */
  trust: "org" | "public" | "owner";
  /**
   * How to become the owner of a bot the platform named none for: the code to send it (null once
   * it expired or was guessed at), and a link that sends it in one tap. Null when it has its owner.
   */
  claim: { code: string | null; expiresAt: number | null; url: string | null } | null;
}

/**
 * A permission the owner grants the bot on the platform itself (docs/spec.md 4.2). `group_messages`:
 * every message in its groups, not only the ones that @ it. `bot_messages`: what other bots send in
 * its groups (Feishu only). `grant.steps` picks the instructions.
 */
export type PermissionId = "group_messages" | "bot_messages" | "doc_comments" | "member_profiles";

export interface BotPermission {
  id: PermissionId;
  granted: boolean;
  /** Not asked for when the bot is created; the owner turns it on here (Feishu member profiles). */
  optional?: boolean;
  grant?: { url: string; steps?: "telegram" | "discord" };
}

/** A person or group waiting for the owner to let them talk to the agent (docs/spec.md 4.7). */
export interface AccessRequest {
  kind: "contact" | "group";
  id: string;
  platform: Platform;
  /** The person's or the group's name. */
  name: string | null;
  /** Who wrote; for a group, the person who @-mentioned the agent there. */
  sender: string | null;
  preview: string;
  count: number;
  at: number;
}

/** A person or group whose access is decided, to change it. */
export interface AccessEntry {
  kind: "contact" | "group";
  id: string;
  platform: Platform;
  /** The bot they wrote to. */
  connection: string;
  name: string | null;
  access: "allowed" | "blocked";
}

export interface SshHost {
  id: string;
  host: string;
  home: string;
  reachable: boolean | null;
}

export interface SshInstallJob {
  id: string;
  host: string;
  home: string;
  state: "running" | "done" | "failed";
  phase: "installing" | "preparing";
  result?: SshHost;
  error?: string;
}

export interface AgentView {
  remote?: { id: string; host: string; reachable: boolean };
  id: string;
  slug: string;
  name: string;
  /** The picture's URL, or null to draw the generated initial. */
  avatar: string | null;
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
  /** Ask about new people and groups on every chat app, not only the public ones. */
  askAll: boolean;
  /** The daily memory tidy-up while the agent is idle (docs/spec.md 4.5). */
  tidy: boolean;
  requests: AccessRequest[];
  /** Things under way at once besides talking: its lines working or waiting their turn (docs/spec.md 4.13). */
  doing: number;
  /**
   * The private chat (docs/spec.md 6.9): what the agent said there that the owner has not seen yet.
   * Absent from a host on a Mingle older than the private chat.
   */
  chat?: { unread: number; last: { id: string; preview: string; at: number } | null };
}

/** A file in the private chat, sent or received. */
export interface ChatFile {
  id: string;
  name: string;
  size: number | null;
  mime: string | null;
}

/** One message of the private chat (docs/spec.md 6.9). */
export interface ChatMessage {
  id: string;
  direction: "in" | "out";
  body: string;
  state: string;
  retryAt: number | null;
  createdAt: number;
  files: ChatFile[];
  line: { id: string; title: string; state: LineState; started: boolean } | null;
}

/** A file the owner attached and has not sent yet. */
export interface ChatUpload {
  id: string;
  name: string;
  size: number;
  mime?: string;
}

/** Where a piece of work an agent is doing on the side stands (docs/spec.md 4.13). */
export type LineState = "running" | "queued" | "waiting" | "done" | "error" | "stopped";

/** One chat app account in the agent's address book. */
export interface ContactAccount {
  id: string;
  platform: Platform;
  /** The bot this account wrote to. */
  connection: string;
  /** The name given to this account, else the app's. */
  name: string | null;
  platformName: string | null;
  owner: boolean;
  /** What the owner decided about them (docs/spec.md 4.7); null when undecided, and for the owner. */
  access: "allowed" | "blocked" | null;
  /** Another account on this platform has a different owner: "you" would be ambiguous. */
  ownerShared: boolean;
  bot: boolean;
  linkedBy: "owner" | "agent" | null;
  /** Department and title from the chat app, where member profiles are on. */
  profile: string | null;
}

/** A person with their accounts, or one account on its own (`person` null). */
export interface ContactEntry {
  person: string | null;
  name: string | null;
  note: string | null;
  accounts: ContactAccount[];
}

/** What the owner handed the agent from another conversation (docs/spec.md 4.12). */
export interface HandoffView {
  id: string;
  body: string;
  via: "command" | "paste";
  state: "waiting" | "delivered";
  /** In bytes. */
  size: number;
  createdAt: number;
  deliveredAt: number | null;
}

/** The most a handoff may hold, in bytes: the server refuses more. */
export const HANDOFF_MAX_BYTES = 200 * 1024;

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
  /** The work this message started, or the work it was handed to. */
  line: { id: string; title: string; state: LineState; started: boolean } | null;
}

/** How often a group that hears everything reaches the agent. */
export type HearTier = "save" | "balanced" | "fast";

export interface Hearing {
  pace: "auto" | "every" | "muted";
  everyMs?: number;
  slowedMs?: number;
  /**
   * Since 0.4.7 (RFC 0001), absent from a host on an older Mingle: how fast it keeps up with a
   * conversation as the owner chose (null follows the group's size). Read through `hearingSettings`.
   */
  tier?: HearTier | null;
  /** The tier the group's size gives it. */
  defaultTier?: HearTier;
  /** The people it is in a conversation with now, by name. */
  live?: string[];
  /** Other names that count as calling it in this group. */
  aliases?: string[];
}

/** A group's tier, names and who it is talking with, as set from the console (docs/spec.md 4.2). */
export interface HearingSettings {
  tier: HearTier | null;
  defaultTier: HearTier;
  live: string[];
  aliases: string[];
}

const TIERS: readonly string[] = ["save", "balanced", "fast"];

/**
 * The settings in a group's hearing, or null when its host runs a Mingle from before them (an SSH
 * host on 0.4.6 sends only the pace): then the console shows the switch and the pace as before.
 */
export function hearingSettings(h: Hearing | null | undefined): HearingSettings | null {
  if (!h || !Array.isArray(h.aliases) || !Array.isArray(h.live)) return null;
  if (typeof h.defaultTier !== "string" || !TIERS.includes(h.defaultTier)) return null;
  const tier = h.tier === null || (typeof h.tier === "string" && TIERS.includes(h.tier)) ? h.tier : null;
  return {
    tier,
    defaultTier: h.defaultTier,
    live: h.live.filter((n): n is string => typeof n === "string"),
    aliases: h.aliases.filter((n): n is string => typeof n === "string"),
  };
}

/** One chat in the activity, with its latest messages (oldest first) and what still needs the owner. */
export interface Conversation {
  chat: { id: string; kind: "dm" | "group" | "thread"; name: string | null };
  /** The channel a thread belongs to. */
  parent: { id: string; kind: "dm" | "group" | "thread"; name: string | null } | null;
  platform: Platform;
  /** A group: whether it hears everything said there. Null where that cannot be set (docs/spec.md 4.2). */
  listen: boolean | null;
  /** A group that hears everything: the pace the agent set, or the slowing in force (docs/spec.md 4.2). */
  hearing: Hearing | null;
  latestAt: number;
  /** Older messages not shown; read them with `cursor` as `before`. */
  earlier: number;
  cursor: number | null;
  messages: Activity[];
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
  canUpdate: boolean;
  /** An installation still running in the local Mingle process. */
  installJob?: Job;
  /** An update still running in the local Mingle process. */
  upgradeJob?: Job;
}

export type UpdateInfo =
  | { kind: "available"; installed: string; latest: string }
  | { kind: "current"; version: string }
  | { kind: "unknown" };

export interface UsageWindow {
  label: string;
  /** Consumed fraction, 0 to 1. */
  used: number;
  resetsAt?: number;
  durationMs?: number;
}

export type AccountUsage = { kind: "available"; rateLimited: boolean; windows: UsageWindow[] } | { kind: "unknown" };

export type SignInState =
  | { kind: "signed_in"; account?: string; plan?: string }
  | { kind: "signed_out"; detail?: string }
  | { kind: "unknown" };

export type InstallPlan =
  | { kind: "plan"; steps: string[]; source: string }
  | { kind: "unsupported"; detail: string; steps?: string[]; source?: string };

export interface Job {
  id: string;
  kind: "install" | "upgrade" | "sign_in";
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
    | { kind: "device" }
    | { kind: "credentials"; fields: CredentialField[]; setupUrl?: string }
    | null;
  manualFields: CredentialField[];
  manualSetupUrl: string | null;
  /** The platform has local prerequisites to check before connecting (iMessage). */
  setup: boolean;
  /** Onboarding can add permissions to an already-connected bot (Feishu). */
  reauthorize: boolean;
}

export type SetupCheckState = "ok" | "missing" | "denied" | "unknown";

export interface SetupState {
  checks: { id: string; state: SetupCheckState }[];
  app?: string;
}

export type OnboardingState =
  | { state: "starting" }
  | { state: "qr"; qrSvg: string; url: string; expiresAt: number }
  | { state: "scanned" }
  | { state: "device"; userCode: string; url: string; expiresAt: number }
  | { state: "awaiting_approval" }
  | { state: "needs_code"; retry: boolean }
  | { state: "done"; connectionId: string; pendingApproval: boolean; bot?: string | null }
  | { state: "failed"; code: string };

export interface Task {
  id: string;
  title: string;
  status: string;
  /** Worked on in a line of its own; null for a task that is only a note. */
  line: LineState | null;
  summary: string | null;
  /** How far the line is, in one line: the latest it said in its thread, or reported. */
  progress: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  /** The chat it came from. */
  from: { name: string | null; platform: Platform | undefined } | null;
}

export interface Reminder {
  id: string;
  body: string;
  rule: string;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  /** A command Mingle runs on the rule; the reminder fires when its output changes. */
  check: { command: string; once: boolean; failures: number; error: string | null } | null;
}

export const api = {
  status: () => call<{ version: string; agents: AgentView[] }>("GET", "/v1/admin/status"),
  sshHosts: () => call<SshHost[]>("GET", "/v1/admin/ssh/hosts"),
  sshConfig: () => call<{ hosts: string[]; incomplete: boolean }>("GET", "/v1/admin/ssh/config"),
  addSshHost: (host: string, home: string) => call<SshHost>("POST", "/v1/admin/ssh/hosts", { host, home }),
  installSshHost: (host: string, home: string) =>
    call<SshInstallJob>("POST", "/v1/admin/ssh/installations", { host, home }),
  sshInstallation: (id: string) => call<SshInstallJob>("GET", `/v1/admin/ssh/installations/${id}`),
  harnesses: (remote?: string) => call<Harness[]>("GET", "/v1/admin/harnesses", undefined, remote),
  /** The last catalog Mingle found at once; `fresh` probes every harness again, a second or more. */
  brains: (fresh = false, remote?: string) =>
    call<BrainStatus[]>("GET", `/v1/admin/brains${fresh ? "?fresh=1" : ""}`, undefined, remote),
  signInState: (harness: string) => call<SignInState>("GET", `/v1/admin/brains/${harness}/sign-in`),
  installPlan: (harness: string) => call<InstallPlan>("GET", `/v1/admin/brains/${harness}/install-plan`),
  install: (harness: string) => call<Job>("POST", `/v1/admin/brains/${harness}/install`),
  updateCheck: (harness: string) => call<UpdateInfo>("GET", `/v1/admin/brains/${harness}/update`),
  accountUsage: (harness: string) => call<AccountUsage>("GET", `/v1/admin/brains/${harness}/usage`),
  upgrade: (harness: string) => call<Job>("POST", `/v1/admin/brains/${harness}/upgrade`),
  signIn: (harness: string) => call<Job>("POST", `/v1/admin/brains/${harness}/sign-in`),
  job: (id: string) => call<Job>("GET", `/v1/admin/jobs/${id}`),
  answerJob: (id: string, value: string) => call("POST", `/v1/admin/jobs/${id}/answer`, { value }),
  cancelJob: (id: string) => call("DELETE", `/v1/admin/jobs/${id}`),
  models: (harness: string) => call<ModelList>("GET", `/v1/admin/harnesses/${harness}/models`),
  updateAgent: (id: string, patch: { name?: string; harness?: string; model?: string | null }) =>
    call<AgentView>("PATCH", `/v1/admin/agents/${id}`, patch),
  platforms: (remote?: string) => call<PlatformInfo[]>("GET", "/v1/admin/platforms", undefined, remote),
  setup: (platform: Platform, remote?: string) =>
    call<SetupState>("GET", `/v1/admin/platforms/${platform}/setup`, undefined, remote),
  setupAction: (platform: Platform, action: string, remote?: string) =>
    call<SetupState>("POST", `/v1/admin/platforms/${platform}/setup/${action}`, undefined, remote),
  createAgent: (input: { name: string; role: string; harness: string; model?: string }) =>
    call<AgentView>("POST", "/v1/admin/agents", input),
  setAvatar: (id: string, image: Blob) => call<AgentView>("PUT", `/v1/admin/agents/${id}/avatar`, image),
  clearAvatar: (id: string) => call<AgentView>("DELETE", `/v1/admin/agents/${id}/avatar`),
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
  diagnosisPrompt: (id: string) => call<{ text: string }>("GET", `/v1/admin/agents/${id}/diagnosis-prompt`),
  /** Try again on failed or unanswered messages: these, or all of them. */
  retry: (id: string, ids?: string[]) =>
    call<{ retried: string[]; offline: string[] }>("POST", `/v1/admin/agents/${id}/messages/retry`, ids ? { ids } : {}),
  /** Dismiss these failed or unanswered messages without sending anything. */
  ignore: (id: string, ids: string[]) =>
    call<{ ignored: string[] }>("POST", `/v1/admin/agents/${id}/messages/ignore`, { ids }),
  remove: (id: string) => call("DELETE", `/v1/admin/agents/${id}`),
  openHome: (id: string) => call("POST", `/v1/admin/agents/${id}/open-home`),
  /** Let a person or group talk to the agent, or turn them away; what they sent meanwhile follows. */
  setAccess: (id: string, kind: "contact" | "group", targetId: string, access: "allowed" | "blocked") =>
    call<{ settled: number }>(
      "POST",
      `/v1/admin/agents/${id}/${kind === "contact" ? "contacts" : "chats"}/${targetId}/access`,
      { access },
    ),
  setListen: (id: string, chatId: string, listen: boolean) =>
    call<{ listen: boolean }>("PUT", `/v1/admin/agents/${id}/chats/${chatId}/listen`, { listen }),
  resetHearing: (id: string, chatId: string) =>
    call<Hearing>("DELETE", `/v1/admin/agents/${id}/chats/${chatId}/hearing`),
  setHearTier: (id: string, chatId: string, tier: HearTier | null) =>
    call<Hearing>("PUT", `/v1/admin/agents/${id}/chats/${chatId}/hearing`, { tier }),
  /** One name at a time, applied on the server to the list as it is now. */
  alias: (id: string, chatId: string, alias: string, add: boolean) =>
    call<Hearing>(add ? "POST" : "DELETE", `/v1/admin/agents/${id}/chats/${chatId}/aliases`, { alias }),
  access: (id: string) => call<AccessEntry[]>("GET", `/v1/admin/agents/${id}/access`),
  setAskAll: (id: string, on: boolean) => call<AgentView>("PUT", `/v1/admin/agents/${id}/ask-all`, { on }),
  setTidy: (id: string, on: boolean) => call<AgentView>("PUT", `/v1/admin/agents/${id}/tidy`, { on }),
  contacts: (id: string) => call<ContactEntry[]>("GET", `/v1/admin/agents/${id}/contacts`),
  /** Name, note (on the person) or bot mark; fields left out stay. */
  editContact: (id: string, contactId: string, patch: { name?: string; note?: string; bot?: boolean }) =>
    call<{ id: string; name: string | null; bot: boolean }>(
      "PATCH",
      `/v1/admin/agents/${id}/contacts/${contactId}`,
      patch,
    ),
  /** These accounts are one person, on the owner's word. */
  linkContacts: (id: string, contacts: string[]) =>
    call<{ person: string }>("POST", `/v1/admin/agents/${id}/people/link`, { contacts }),
  unlinkContact: (id: string, contact: string) =>
    call<{ ok: true }>("POST", `/v1/admin/agents/${id}/people/unlink`, { contact }),
  conversations: (id: string, page?: { chat: string; before: number }) =>
    call<Conversation[]>(
      "GET",
      `/v1/admin/agents/${id}/conversations${page ? `?chat=${encodeURIComponent(page.chat)}&before=${page.before}&messages=20` : ""}`,
    ),
  /** The private chat, newest last; `watching` while the console shows it, so what is there counts as seen. */
  chat: (id: string, options: { before?: string; watching?: boolean } = {}) =>
    call<{ messages: ChatMessage[]; more: boolean }>(
      "GET",
      `/v1/admin/agents/${id}/chat?limit=50${options.before ? `&before=${encodeURIComponent(options.before)}` : ""}${options.watching ? "&watching=1" : ""}`,
    ),
  say: (id: string, text: string, files: string[]) =>
    call<ChatMessage>("POST", `/v1/admin/agents/${id}/chat`, { text, files }),
  /** Keep a file to send with the next message. */
  upload: async (id: string, file: File): Promise<ChatUpload> => {
    let response: Response;
    try {
      response = await fetch(`/v1/admin/agents/${id}/chat/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) ?? ""}`,
          "content-type": file.type || "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
        },
        body: file,
      });
    } catch {
      throw new ApiError("offline", "", 0);
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = payload as { error?: string; next?: string };
      throw new ApiError(error.error ?? "http_error", error.next ?? response.statusText, response.status);
    }
    return payload as ChatUpload;
  },
  /** A file of the private chat, as bytes to show or save. */
  chatFile: async (id: string, fileId: string): Promise<Blob> => {
    const response = await fetch(`/v1/admin/agents/${id}/chat/files/${fileId}`, {
      headers: { authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) ?? ""}` },
    }).catch(() => {
      throw new ApiError("offline", "", 0);
    });
    if (!response.ok) throw new ApiError("file_not_found", "", response.status);
    return response.blob();
  },
  revealFile: (id: string, fileId: string) => call("POST", `/v1/admin/agents/${id}/chat/files/${fileId}/reveal`),
  handoffs: (id: string) => call<HandoffView[]>("GET", `/v1/admin/agents/${id}/handoffs?limit=30`),
  handoff: (id: string, body: string) =>
    call<{ handoff: HandoffView; state: "idle" | "busy" | "paused" }>("POST", `/v1/admin/agents/${id}/handoffs`, {
      body,
      via: "paste",
    }),
  /** What to give the other conversation so it hands off with a command. */
  handoffPrompt: (id: string) => call<{ text: string }>("GET", `/v1/admin/agents/${id}/handoff-prompt`),
  work: (id: string) => call<{ tasks: Task[]; reminders: Reminder[] }>("GET", `/v1/admin/agents/${id}/work`),
  /** Stop a reminder for good; the agent hears it with its next input. */
  cancelReminder: (id: string, reminderId: string) => call("DELETE", `/v1/admin/agents/${id}/reminders/${reminderId}`),
  /** Close an open task; the agent hears it with its next input. */
  closeTask: (id: string, taskId: string) =>
    call<{ changed: boolean }>("POST", `/v1/admin/agents/${id}/tasks/${taskId}/close`),
  connect: (id: string, platform: Platform, credentials: Record<string, string>) =>
    call<{ id: string; bot: string | null }>("POST", `/v1/admin/agents/${id}/connections`, { platform, credentials }),
  disconnect: (connectionId: string) => call("DELETE", `/v1/admin/connections/${connectionId}`),
  /** Try an offline bot again now. */
  reconnect: (connectionId: string) => call("POST", `/v1/admin/connections/${connectionId}/reconnect`),
  /** What the owner can still grant the bot on the platform, read live; empty while it is offline. */
  permissions: (connectionId: string) =>
    call<{ permissions: BotPermission[] }>("GET", `/v1/admin/connections/${connectionId}/permissions`),
  /** A fresh code for claiming a bot that has no owner yet. */
  claim: (connectionId: string) =>
    call<{ code: string; expiresAt: number }>("POST", `/v1/admin/connections/${connectionId}/claim`),
  startOnboarding: (id: string, platform: Platform, connectionId?: string, adding?: readonly PermissionId[]) =>
    call<{ id: string }>("POST", `/v1/admin/agents/${id}/onboarding`, {
      platform,
      ...(connectionId ? { connectionId } : {}),
      ...(adding?.length ? { adding } : {}),
    }),
  onboarding: (id: string) => call<OnboardingState>("GET", `/v1/admin/onboarding/${id}`),
  cancelOnboarding: (id: string) => call("DELETE", `/v1/admin/onboarding/${id}`),
  submitCode: (id: string, code: string) => call("POST", `/v1/admin/onboarding/${id}/code`, { code }),
};
