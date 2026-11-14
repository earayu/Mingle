import type {
  BotIdentity,
  Capabilities,
  Channel,
  ChannelConnection,
  ChannelEvents,
  ChatRef,
  CredentialField,
  Credentials,
  InboundMessage,
  OnboardingEvent,
  OnboardingMethod,
  OutboundMessage,
  ReactionState,
  SendResult,
} from "../channel.ts";

/**
 * GitHub: the agent is a machine account people @-mention in issues and pull requests
 * (docs/spec.md 6.7). Mentions arrive through the REST notifications API, polled from this
 * computer, so no webhook and no public address are needed. Replies are comments in the same
 * thread; a reply to an inline review comment stays in that review thread.
 *
 * Message ids carry what the API needs to reach the message again:
 * `i:<number>` the issue or pull request itself, `ic:<id>` an issue comment,
 * `rc:<id>@<root>` an inline review comment and the top-level comment of its thread,
 * `rv:<id>` a review's summary. Chats are `<owner>/<repo>#<number>`.
 */

type Fetch = typeof fetch;

interface GhUser {
  login: string;
  id: number;
  type?: string;
  name?: string | null;
}

interface GhNotification {
  id: string;
  reason: string;
  updated_at: string;
  last_read_at: string | null;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string };
}

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  user: GhUser | null;
  author_association: string;
  created_at: string;
  pull_request?: unknown;
}

interface GhComment {
  id: number;
  body: string | null;
  user: GhUser | null;
  author_association: string;
  created_at: string;
}

interface GhReviewComment extends GhComment {
  in_reply_to_id?: number;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

interface GhReview {
  id: number;
  body: string | null;
  user: GhUser | null;
  author_association: string;
  submitted_at?: string | null;
}

interface GhReaction {
  id: number;
  content: string;
  user: GhUser | null;
}

export class GhError extends Error {
  readonly status: number;
  readonly detail: string;
  constructor(status: number, detail: string) {
    super(`GitHub ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

const CAPABILITIES: Capabilities = {
  // Issue comments are flat; only inline review comments thread, and replies land there.
  quoteReply: false,
  reactions: true,
  typingIndicator: false,
  fileUpload: false,
  fileDownload: false,
  listMembers: false,
  maxTextLength: 65_536,
};

/** Notification reasons that can carry something for the agent: a mention, or activity in a thread it is in. */
const REASONS = new Set(["mention", "team_mention", "comment", "author"]);
/** Commenters whose mention starts a turn. Anyone else on a public repository is ignored (docs/spec.md 6.7). */
const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
/** The scopes Mingle asks for; the notifications API takes classic scopes only. */
export const GITHUB_SCOPES = ["notifications", "repo"] as const;
/** How far back a thread never read before is searched for the mention. */
const FIRST_LOOK_MS = 7 * 24 * 3600_000;

const TOKEN_FIELD: CredentialField = { key: "token", labelKey: "github.token", secret: true };
const TOKEN_URL = `https://github.com/settings/tokens/new?scopes=${GITHUB_SCOPES.join(",")}&description=Mingle%20(__MINGLE_AGENT_NAME__)`;

export interface GitHubOptions {
  readonly fetch?: Fetch;
  readonly apiBase?: string;
  readonly webBase?: string;
  /**
   * The public client ID of Mingle's OAuth App, for signing in with a code (device flow). Without
   * one, the person pastes a classic token instead.
   */
  readonly clientId?: string;
  /** Floor for the wait between polls, in milliseconds; GitHub's `X-Poll-Interval` can only raise it. */
  readonly pollMs?: number;
  readonly now?: () => number;
}

export function githubChannel(options: GitHubOptions = {}): Channel {
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? "https://api.github.com";
  const webBase = options.webBase ?? "https://github.com";
  const clientId = options.clientId ?? process.env.MINGLE_GITHUB_CLIENT_ID ?? "";
  const pollFloor = options.pollMs ?? 60_000;
  const now = options.now ?? Date.now;

  function client(token: string) {
    async function request(
      method: string,
      path: string,
      body?: unknown,
      init: { signal?: AbortSignal; headers?: Record<string, string> } = {},
    ): Promise<Response> {
      const timeout = AbortSignal.timeout(20_000);
      const response = await fetchImpl(`${apiBase}${path}`, {
        method,
        signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "Mingle",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status >= 400) {
        const json = (await response.json().catch(() => ({}))) as { message?: string };
        throw new GhError(response.status, json.message ?? response.statusText);
      }
      return response;
    }
    async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
      const response = await request(method, path, body, signal ? { signal } : {});
      if (response.status === 204 || response.status === 205) return undefined as T;
      return (await response.json()) as T;
    }
    return { request, call };
  }

  /** Who the token belongs to, and whether it carries the scopes Mingle needs. */
  async function whoami(token: string): Promise<{ user: GhUser; scopesOk: boolean }> {
    const response = await client(token).request("GET", "/user");
    const user = (await response.json()) as GhUser;
    // Fine-grained and GitHub App tokens send no scope header, and cannot read notifications at all.
    const scopes = (response.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
    const scopesOk = scopes.includes("notifications") && (scopes.includes("repo") || scopes.includes("public_repo"));
    return { user, scopesOk };
  }

  async function* fromToken(token: string): AsyncIterable<OnboardingEvent> {
    try {
      const { user, scopesOk } = await whoami(token);
      if (!scopesOk) {
        yield { kind: "failed", code: "insufficient_scope" };
        return;
      }
      yield { kind: "succeeded", credentials: { token }, bot: identity(user) };
    } catch (error) {
      yield {
        kind: "failed",
        code: error instanceof GhError && error.status === 401 ? "invalid_credentials" : "network",
      };
    }
  }

  /** OAuth device flow: a code the person enters on github.com while signed in as the agent's account. */
  async function* deviceFlow(signal: AbortSignal): AsyncIterable<OnboardingEvent> {
    const post = async <T>(path: string, body: Record<string, string>): Promise<T> => {
      const response = await fetchImpl(`${webBase}${path}`, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "Mingle" },
        body: JSON.stringify(body),
      });
      return (await response.json().catch(() => ({}))) as T;
    };
    let device: {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
    };
    try {
      device = await post("/login/device/code", { client_id: clientId, scope: GITHUB_SCOPES.join(" ") });
    } catch {
      if (!signal.aborted) yield { kind: "failed", code: "network" };
      return;
    }
    if (!device.device_code || !device.user_code) {
      yield { kind: "failed", code: "unknown" };
      return;
    }
    const expiresAt = now() + (device.expires_in ?? 900) * 1000;
    yield {
      kind: "device_code",
      userCode: device.user_code,
      verificationUri: device.verification_uri ?? `${webBase}/login/device`,
      expiresAt,
    };
    let interval = (device.interval ?? 5) * 1000;
    while (!signal.aborted) {
      await sleep(interval, signal);
      if (signal.aborted) return;
      if (now() >= expiresAt) {
        yield { kind: "failed", code: "expired" };
        return;
      }
      let answer: { access_token?: string; error?: string; interval?: number };
      try {
        answer = await post("/login/oauth/access_token", {
          client_id: clientId,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
      } catch {
        if (signal.aborted) return;
        continue; // A dropped poll is retried; the code stays valid.
      }
      if (answer.access_token) {
        yield* fromToken(answer.access_token);
        return;
      }
      if (answer.error === "authorization_pending") continue;
      if (answer.error === "slow_down") {
        interval = (answer.interval ?? interval / 1000 + 5) * 1000;
        continue;
      }
      yield {
        kind: "failed",
        code: answer.error === "access_denied" ? "denied" : answer.error === "expired_token" ? "expired" : "unknown",
      };
      return;
    }
  }

  const onboarding: OnboardingMethod = clientId
    ? { kind: "device" }
    : { kind: "credentials", fields: [TOKEN_FIELD], setupUrl: TOKEN_URL };

  return {
    platform: "github",
    onboarding,
    ...(clientId ? { manualFields: [TOKEN_FIELD], manualSetupUrl: TOKEN_URL } : {}),

    async *onboard(input, signal): AsyncIterable<OnboardingEvent> {
      const token = input?.token?.trim();
      if (token) {
        yield* fromToken(token);
        return;
      }
      if (input || !clientId) {
        yield { kind: "failed", code: "invalid_credentials" };
        return;
      }
      yield* deviceFlow(signal);
    },

    async connect(credentials: Credentials, events: ChannelEvents): Promise<ChannelConnection> {
      const api = client(credentials.token ?? "");
      const me = (await api.call<GhUser>("GET", "/user")) as GhUser;
      const bot = identity(me);
      const stop = new AbortController();
      /** The last listing's ETag: asking with it costs no rate limit while nothing changed. */
      let etag = "";
      /** Threads marked read whose new comments are not delivered yet, with where to read from. */
      const pending = new Map<string, GhNotification>();

      /** Every new comment in one notified thread, oldest first, as Mingle messages. */
      const readThread = async (n: GhNotification): Promise<InboundMessage[]> => {
        const where = parseSubject(n.subject.url);
        if (!where || (n.subject.type !== "Issue" && n.subject.type !== "PullRequest")) return [];
        const { repo, number } = where;
        const since = n.last_read_at ?? new Date(Date.parse(n.updated_at) - FIRST_LOOK_MS).toISOString();
        const after = Date.parse(since);
        const issue = await api.call<GhIssue>("GET", `/repos/${repo}/issues/${number}`, undefined, stop.signal);
        const chat: ChatRef = {
          platformId: `${repo}#${number}`,
          kind: "thread",
          name: `${repo}#${number} ${issue.title}`,
        };
        const out: { at: number; message: InboundMessage }[] = [];
        const mentionsMe = (text: string) =>
          mentions(text, me.login) || (n.reason === "team_mention" && /(^|[^\w-])@[\w-]+\/[\w.-]+/.test(text));
        const add = (
          platformId: string,
          author: GhUser | null,
          association: string,
          at: string,
          body: string,
          extra: { addressed?: boolean; replyTo?: string; prefix?: string } = {},
        ) => {
          const time = Date.parse(at);
          if (!author || time <= after || author.login.toLowerCase() === me.login.toLowerCase()) return;
          // Outsiders on public repositories cannot start a turn, and are not kept as context either.
          if (!TRUSTED.has(association)) return;
          const text = stripMention(body, me.login);
          out.push({
            at: time,
            message: {
              platformId,
              chat,
              sender: { id: author.login, name: author.login, isBot: author.type === "Bot" },
              text: extra.prefix ? `${extra.prefix}\n\n${text}` : text,
              attachments: [],
              ...(extra.replyTo ? { replyTo: extra.replyTo } : {}),
              addressedToBot: Boolean(extra.addressed) || mentionsMe(body),
              sentAt: time,
            },
          });
        };

        add(`i:${number}`, issue.user, issue.author_association, issue.created_at, issue.body ?? "");
        const comments = await api.call<GhComment[]>(
          "GET",
          `/repos/${repo}/issues/${number}/comments?since=${encodeURIComponent(since)}&per_page=100`,
          undefined,
          stop.signal,
        );
        for (const c of comments) add(`ic:${c.id}`, c.user, c.author_association, c.created_at, c.body ?? "");

        if (issue.pull_request) {
          const reviewComments = await api.call<GhReviewComment[]>(
            "GET",
            `/repos/${repo}/pulls/${number}/comments?since=${encodeURIComponent(since)}&per_page=100`,
            undefined,
            stop.signal,
          );
          const authors = new Map<number, string>(reviewComments.map((c) => [c.id, c.user?.login ?? ""]));
          for (const c of reviewComments) {
            const root = c.in_reply_to_id ?? c.id;
            let rootAuthor = authors.get(root);
            if (rootAuthor === undefined && Date.parse(c.created_at) > after) {
              rootAuthor = await api
                .call<GhReviewComment>("GET", `/repos/${repo}/pulls/comments/${root}`, undefined, stop.signal)
                .then((r) => r.user?.login ?? "")
                .catch(() => "");
            }
            const line = c.line ?? c.original_line;
            add(`rc:${c.id}@${root}`, c.user, c.author_association, c.created_at, c.body ?? "", {
              // Answering in a review thread the agent started is talking to it, as a reply is in a chat.
              addressed: rootAuthor?.toLowerCase() === me.login.toLowerCase(),
              ...(c.in_reply_to_id ? { replyTo: `rc:${root}@${root}` } : {}),
              ...(c.path ? { prefix: `(on \`${c.path}\`${line ? ` line ${line}` : ""})` } : {}),
            });
          }
          const reviews = await api.call<GhReview[]>(
            "GET",
            `/repos/${repo}/pulls/${number}/reviews?per_page=100`,
            undefined,
            stop.signal,
          );
          for (const r of reviews) {
            if (r.body?.trim() && r.submitted_at)
              add(`rv:${r.id}`, r.user, r.author_association, r.submitted_at, r.body);
          }
        }
        return out.sort((a, b) => a.at - b.at).map((e) => e.message);
      };

      const poll = async () => {
        let failures = 0;
        while (!stop.signal.aborted) {
          let wait = pollFloor;
          try {
            const response = await api.request("GET", "/notifications?participating=true&per_page=50", undefined, {
              signal: stop.signal,
              // Measured: GitHub answers If-None-Match with 304, but If-Modified-Since with a full 200.
              headers: etag ? { "if-none-match": etag } : {},
            });
            wait = Math.max(pollFloor, Number(response.headers.get("x-poll-interval") ?? 0) * 1000);
            if (failures > 0) events.onState({ kind: "connected" });
            failures = 0;
            if (response.status !== 304) {
              const notifications = (await response.json()) as GhNotification[];
              for (const n of notifications) {
                if (!REASONS.has(n.reason)) continue; // Left unread: not something Mingle answers.
                // Marked read before its comments are read: one that lands meanwhile makes the
                // thread unread again, so it comes back on the next poll instead of being lost.
                await api.request("PATCH", `/notifications/threads/${n.id}`, undefined, { signal: stop.signal });
                const earlier = pending.get(n.id);
                pending.set(n.id, earlier ? { ...n, last_read_at: earlier.last_read_at } : n);
              }
              etag = response.headers.get("etag") ?? "";
            }
            let retryable: unknown;
            for (const [id, n] of pending) {
              try {
                const messages = await readThread(n);
                pending.delete(id);
                for (const message of messages) events.onMessage(message);
              } catch (error) {
                if (stop.signal.aborted) return;
                // A thread that is gone, or this account can no longer see, is dropped; the rest wait.
                if (
                  error instanceof GhError &&
                  [403, 404, 410].includes(error.status) &&
                  !/rate limit/i.test(error.detail)
                )
                  pending.delete(id);
                else retryable = error;
              }
            }
            if (retryable) throw retryable;
          } catch (error) {
            if (stop.signal.aborted) return;
            if (error instanceof GhError && error.status === 401) {
              events.onState({ kind: "error", code: "credentials_revoked" });
              return;
            }
            if (error instanceof GhError && error.status === 403 && !/rate limit/i.test(error.detail)) {
              // The token lost the notifications scope, or is a kind that cannot read them.
              events.onState({ kind: "error", code: "permission_missing" });
              return;
            }
            failures++;
            events.onState({ kind: "reconnecting", attempt: failures });
            wait = Math.min(15 * 60_000, Math.max(pollFloor, 1000 * 2 ** failures));
          }
          await sleep(wait, stop.signal);
        }
      };
      void poll();

      /** Remove this account's own reaction of one kind, if it has one. */
      const unreact = async (target: string, content: string) => {
        const reactions = await api.call<GhReaction[]>("GET", `${target}?content=${content}&per_page=100`);
        for (const r of reactions) {
          if (r.user?.login.toLowerCase() === me.login.toLowerCase()) await api.call("DELETE", `${target}/${r.id}`);
        }
      };

      return {
        bot,
        capabilities: () => CAPABILITIES,

        async send(message: OutboundMessage): Promise<SendResult> {
          const { repo, number } = parseChat(message.chat.platformId);
          const degraded = message.files?.length ? (["files_dropped"] as const) : undefined;
          if (!message.text.trim()) {
            // The API cannot attach files to a comment; with no text there is nothing to post.
            return { kind: "failed", code: "unknown", retryable: false, detail: "files_unsupported" };
          }
          try {
            const review = message.replyTo ? reviewRoot(message.replyTo) : undefined;
            if (review) {
              const sent = await api.call<GhComment>(
                "POST",
                `/repos/${repo}/pulls/${number}/comments/${review}/replies`,
                { body: message.text },
              );
              return { kind: "sent", platformId: `rc:${sent.id}@${review}`, ...(degraded ? { degraded } : {}) };
            }
            const sent = await api.call<GhComment>("POST", `/repos/${repo}/issues/${number}/comments`, {
              body: message.text,
            });
            return { kind: "sent", platformId: `ic:${sent.id}`, ...(degraded ? { degraded } : {}) };
          } catch (error) {
            return sendFailure(error);
          }
        },

        /** 👀 while the agent works, 🚀 once it answered, 😕 if the turn failed. */
        async react(chat: ChatRef, platformMessageId: string, state: ReactionState) {
          const target = reactionTarget(parseChat(chat.platformId).repo, platformMessageId);
          if (!target) return;
          try {
            if (state === "processing") {
              await api.call("POST", target, { content: "eyes" });
              return;
            }
            await unreact(target, "eyes");
            if (state === "done") await api.call("POST", target, { content: "rocket" });
            else if (state === "error") await api.call("POST", target, { content: "confused" });
          } catch {}
        },

        async setTyping() {},

        async download() {
          throw new Error("GitHub comments carry files as links; open the link instead");
        },

        async listMembers() {
          return [];
        },

        async close() {
          stop.abort();
        },
      };
    },
  };
}

function identity(user: GhUser): BotIdentity {
  return { id: String(user.id), name: `@${user.login}` };
}

/** `https://api.github.com/repos/o/r/issues/12` → `o/r` and 12. Pull requests come as `/pulls/12`. */
export function parseSubject(url: string | null): { repo: string; number: number } | undefined {
  const match = url && /\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/.exec(url);
  return match?.[1] && match[2] ? { repo: match[1], number: Number(match[2]) } : undefined;
}

function parseChat(platformId: string): { repo: string; number: number } {
  const at = platformId.lastIndexOf("#");
  return { repo: platformId.slice(0, at), number: Number(platformId.slice(at + 1)) };
}

/** The review thread a reply belongs in, for a message inside one. */
function reviewRoot(platformId: string): string | undefined {
  return /^rc:\d+@(\d+)$/.exec(platformId)?.[1];
}

/** Where reactions on a message live. Review summaries take none. */
function reactionTarget(repo: string, platformId: string): string | undefined {
  const [kind, rest = ""] = platformId.split(":");
  const id = rest.split("@")[0];
  if (kind === "i") return `/repos/${repo}/issues/${id}/reactions`;
  if (kind === "ic") return `/repos/${repo}/issues/comments/${id}/reactions`;
  if (kind === "rc") return `/repos/${repo}/pulls/comments/${id}/reactions`;
  return undefined;
}

/** `@login` as a whole handle, not inside an email address or a longer handle. Exported for tests. */
export function mentions(text: string, login: string): boolean {
  return mentionPattern(login).test(text);
}

/** The text without the agent's own handle, the way other chats drop the bot's @-mention. */
export function stripMention(text: string, login: string): string {
  return text
    .replace(mentionPattern(login, "g"), "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function mentionPattern(login: string, flags = ""): RegExp {
  const escaped = login.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(^|[^\\w@/-])@${escaped}(?![\\w-])`, `i${flags}`);
}

function sendFailure(error: unknown): SendResult {
  if (error instanceof GhError) {
    const detail = `${error.status} ${error.detail}`.slice(0, 200);
    if (error.status === 429 || (error.status === 403 && /rate limit/i.test(error.detail)))
      return { kind: "failed", code: "rate_limited", retryable: true, detail };
    if (error.status === 401 || error.status === 403)
      return { kind: "failed", code: "forbidden", retryable: false, detail };
    if (error.status === 404 || error.status === 410)
      return { kind: "failed", code: "chat_gone", retryable: false, detail };
    if (error.status === 422 && /too long|maximum/i.test(error.detail))
      return { kind: "failed", code: "too_large", retryable: false, detail };
    return { kind: "failed", code: "unknown", retryable: error.status >= 500, detail };
  }
  // The comment may have been posted before the timeout fired: do not post it twice.
  if ((error as Error)?.name === "TimeoutError" || (error as Error)?.name === "AbortError")
    return { kind: "uncertain" };
  return { kind: "failed", code: "network", retryable: true };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
