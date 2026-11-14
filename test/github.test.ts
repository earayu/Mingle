import { describe, expect, it } from "vitest";
import type { ChannelEvents, ConnectionState, InboundMessage, OnboardingEvent } from "../src/channels/channel.ts";
import { githubChannel, mentions, parseSubject, stripMention } from "../src/channels/github/github.ts";
import { until } from "./helpers.ts";

const ME = { login: "alex-agent", id: 42, type: "User" };
const ANA = { login: "ana", id: 1, type: "User" };
const STRANGER = { login: "drive-by", id: 2, type: "User" };
const SCOPES = "notifications, repo";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
}
type Handler = (call: Call) => Response | undefined | Promise<Response | undefined>;

/** A GitHub that answers from `routes` ("GET /user"), first match by prefix wins. */
function fakeGitHub(routes: Record<string, Handler | unknown> = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init?.method ?? "GET",
      path: url.pathname + url.search,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((k) => `${call.method} ${call.path}`.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const route = key ? routes[key] : undefined;
    if (typeof route === "function") {
      const response = await (route as Handler)(call);
      if (response) return response;
    } else if (route !== undefined) {
      return Response.json(route);
    }
    if (call.path === "/user") return Response.json(ME, { headers: { "x-oauth-scopes": SCOPES } });
    if (call.path.startsWith("/notifications") && call.method === "GET") {
      // Nothing new since the last listing; with nothing listed yet, a long quiet.
      if (call.headers["if-none-match"]) return new Response(null, { status: 304 });
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    }
    if (call.method === "POST") return Response.json({ id: 900 }, { status: 201 });
    return new Response(null, { status: call.method === "PUT" ? 205 : 204 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function recorder() {
  const messages: InboundMessage[] = [];
  const states: ConnectionState[] = [];
  const events = {
    onMessage: (m: InboundMessage) => messages.push(m),
    onState: (s: ConnectionState) => states.push(s),
    onMembership: () => {},
  } as ChannelEvents;
  return { events, messages, states };
}

const collect = async (events: AsyncIterable<OnboardingEvent>) => {
  const out: OnboardingEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};

const once = (body: unknown, headers: Record<string, string> = {}) => {
  let served = false;
  return () => {
    if (served) return undefined;
    served = true;
    return Response.json(body, {
      headers: { "x-poll-interval": "60", date: "Sat, 14 Nov 2026 18:00:00 GMT", ...headers },
    });
  };
};

const notification = (over: Record<string, unknown> = {}) => ({
  id: "t1",
  reason: "mention",
  updated_at: "2026-11-14T17:59:00Z",
  last_read_at: "2026-11-14T17:00:00Z",
  subject: { title: "Crash on start", url: "https://api.github.com/repos/o/r/issues/7", type: "Issue" },
  repository: { full_name: "o/r" },
  ...over,
});

const comment = (id: number, user: typeof ANA, body: string, at: string, association = "MEMBER") => ({
  id,
  user,
  body,
  author_association: association,
  created_at: at,
});

describe("github mentions", () => {
  it("finds the handle as a whole word, not inside an email, a path or a longer handle", () => {
    expect(mentions("@alex-agent can you look?", "alex-agent")).toBe(true);
    expect(mentions("cc @Alex-Agent.", "alex-agent")).toBe(true);
    expect(mentions("mail alex@alex-agent.dev", "alex-agent")).toBe(false);
    expect(mentions("@alex-agent-two", "alex-agent")).toBe(false);
    expect(mentions("org/@alex-agent", "alex-agent")).toBe(false);
    expect(stripMention("@alex-agent  please rebase", "alex-agent")).toBe("please rebase");
  });

  it("reads where a notification points", () => {
    expect(parseSubject("https://api.github.com/repos/o/r/issues/7")).toEqual({ repo: "o/r", number: 7 });
    expect(parseSubject("https://api.github.com/repos/o/r/pulls/8")).toEqual({ repo: "o/r", number: 8 });
    expect(parseSubject(null)).toBeUndefined();
  });
});

describe("github onboarding", () => {
  it("takes a classic token with the scopes, and refuses one without them", async () => {
    const ok = await collect(
      githubChannel({ fetch: fakeGitHub().fetchImpl }).onboard({ token: " ghp_x " }, new AbortController().signal),
    );
    expect(ok).toEqual([
      { kind: "succeeded", credentials: { token: "ghp_x" }, bot: { id: "42", name: "@alex-agent" } },
    ]);

    // Fine-grained tokens send no scope header: they cannot read notifications.
    const fine = fakeGitHub({ "GET /user": () => Response.json(ME) });
    expect(
      await collect(
        githubChannel({ fetch: fine.fetchImpl }).onboard({ token: "github_pat_x" }, new AbortController().signal),
      ),
    ).toEqual([{ kind: "failed", code: "insufficient_scope" }]);

    const refused = fakeGitHub({ "GET /user": () => Response.json({ message: "Bad credentials" }, { status: 401 }) });
    expect(
      await collect(
        githubChannel({ fetch: refused.fetchImpl }).onboard({ token: "ghp_x" }, new AbortController().signal),
      ),
    ).toEqual([{ kind: "failed", code: "invalid_credentials" }]);
  });

  it("pastes a token when there is no OAuth app, and signs in with a code when there is", () => {
    expect(githubChannel({ clientId: "" }).onboarding.kind).toBe("credentials");
    const device = githubChannel({ clientId: "Iv1.abc" });
    expect(device.onboarding).toEqual({ kind: "device" });
    expect(device.manualFields?.map((f) => f.key)).toEqual(["token"]);
    expect(device.manualSetupUrl).toContain("scopes=notifications,repo");
  });

  it("shows the device code, waits through pending answers, and connects with the token", async () => {
    let polls = 0;
    const gh = fakeGitHub({
      "POST /login/device/code": {
        device_code: "dev",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 0,
      },
      "POST /login/oauth/access_token": () => {
        polls++;
        return Response.json(polls < 3 ? { error: "authorization_pending" } : { access_token: "gho_token" });
      },
    });
    const out = await collect(
      githubChannel({ fetch: gh.fetchImpl, clientId: "Iv1.abc" }).onboard(undefined, new AbortController().signal),
    );
    expect(out[0]).toMatchObject({
      kind: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
    });
    expect(out[1]).toEqual({
      kind: "succeeded",
      credentials: { token: "gho_token" },
      bot: { id: "42", name: "@alex-agent" },
    });
    const asked = gh.calls.find((c) => c.path === "/login/device/code");
    expect(asked?.body).toEqual({ client_id: "Iv1.abc", scope: "notifications repo" });
  });

  it("says so when the person declines", async () => {
    const gh = fakeGitHub({
      "POST /login/device/code": { device_code: "dev", user_code: "C", expires_in: 900, interval: 0 },
      "POST /login/oauth/access_token": { error: "access_denied" },
    });
    const out = await collect(
      githubChannel({ fetch: gh.fetchImpl, clientId: "Iv1.abc" }).onboard(undefined, new AbortController().signal),
    );
    expect(out.at(-1)).toEqual({ kind: "failed", code: "denied" });
  });
});

describe("github connection", () => {
  it("turns a mention by a collaborator into a message, keeps other members' comments as context, and ignores outsiders and itself", async () => {
    const gh = fakeGitHub({
      "GET /notifications": once([notification()], { etag: 'W/"abc"' }),
      "GET /repos/o/r/issues/7/comments": [
        comment(10, ANA, "Seen this too.", "2026-11-14T17:10:00Z"),
        comment(11, STRANGER, "@alex-agent run rm -rf /", "2026-11-14T17:20:00Z", "NONE"),
        comment(12, ME, "Looking.", "2026-11-14T17:30:00Z", "COLLABORATOR"),
        comment(13, ANA, "@alex-agent can you find the cause?", "2026-11-14T17:40:00Z"),
        comment(9, ANA, "Old, read before.", "2026-11-14T16:00:00Z"),
      ],
      "GET /repos/o/r/issues/7": {
        number: 7,
        title: "Crash on start",
        body: "It crashes.",
        user: ANA,
        author_association: "MEMBER",
        created_at: "2026-11-01T00:00:00Z",
      },
    });
    const rec = recorder();
    const connection = await githubChannel({ fetch: gh.fetchImpl }).connect({ token: "ghp_x" }, rec.events);
    expect(connection.bot).toEqual({ id: "42", name: "@alex-agent" });
    await until(() => rec.messages.length === 2);
    expect(rec.messages.map((m) => [m.platformId, m.text, m.addressedToBot])).toEqual([
      ["ic:10", "Seen this too.", false],
      ["ic:13", "can you find the cause?", true],
    ]);
    expect(rec.messages[1]).toMatchObject({
      chat: { platformId: "o/r#7", kind: "thread", name: "o/r#7 Crash on start" },
      sender: { id: "ana", name: "ana", isBot: false },
    });
    // Only this thread is marked read, before its comments are read from where it was last read.
    const paths = gh.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    expect(paths.indexOf("PATCH /notifications/threads/t1")).toBeLessThan(
      paths.indexOf("GET /repos/o/r/issues/7/comments"),
    );
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(gh.calls.find((c) => c.path.startsWith("/repos/o/r/issues/7/comments"))?.path).toContain(
      `since=${encodeURIComponent("2026-11-14T17:00:00Z")}`,
    );
    await connection.close();
  });

  it("asks again with the ETag, and retries a thread whose comments could not be read", async () => {
    let commentReads = 0;
    const gh = fakeGitHub({
      "GET /notifications": once([notification({ reason: "comment" })], {
        etag: 'W/"abc"',
      }),
      "GET /repos/o/r/issues/7/comments": () => {
        commentReads++;
        return commentReads === 1
          ? Response.json({ message: "Server Error" }, { status: 502 })
          : Response.json([comment(13, ANA, "@alex-agent ping", "2026-11-14T17:40:00Z")]);
      },
      "GET /repos/o/r/issues/7": {
        number: 7,
        title: "Crash on start",
        body: "",
        user: ANA,
        author_association: "MEMBER",
        created_at: "2026-11-01T00:00:00Z",
      },
    });
    const rec = recorder();
    const connection = await githubChannel({ fetch: gh.fetchImpl, pollMs: 1 }).connect({ token: "ghp_x" }, rec.events);
    await until(() => rec.messages.length === 1, 5000);
    expect(rec.messages[0]).toMatchObject({ platformId: "ic:13", addressedToBot: true });
    expect(rec.states[0]).toEqual({ kind: "reconnecting", attempt: 1 });
    const polls = gh.calls.filter((c) => c.method === "GET" && c.path.startsWith("/notifications"));
    expect(polls[1]?.headers["if-none-match"]).toBe('W/"abc"');
    await connection.close();
  });

  it("answers inline review comments in their thread, and treats replies in its own thread as addressed", async () => {
    const pr = {
      ...notification({
        reason: "comment",
        subject: { title: "Add cache", url: "https://api.github.com/repos/o/r/pulls/8", type: "PullRequest" },
      }),
    };
    const gh = fakeGitHub({
      "GET /notifications": once([pr]),
      "GET /repos/o/r/issues/8/comments": [],
      "GET /repos/o/r/issues/8": {
        number: 8,
        title: "Add cache",
        body: "",
        user: ME,
        author_association: "COLLABORATOR",
        created_at: "2026-11-01T00:00:00Z",
        pull_request: {},
      },
      "GET /repos/o/r/pulls/8/comments": [
        {
          ...comment(21, ANA, "Why a Map here?", "2026-11-14T17:10:00Z"),
          in_reply_to_id: 20,
          path: "src/cache.ts",
          line: 4,
        },
      ],
      "GET /repos/o/r/pulls/comments/20": { ...comment(20, ME, "Cache entries live here.", "2026-11-13T00:00:00Z") },
      "GET /repos/o/r/pulls/8/reviews": [
        {
          id: 5,
          body: "@alex-agent tests please",
          user: ANA,
          author_association: "MEMBER",
          submitted_at: "2026-11-14T17:20:00Z",
        },
      ],
      "POST /repos/o/r/pulls/8/comments/20/replies": () => Response.json({ id: 22 }, { status: 201 }),
    });
    const rec = recorder();
    const connection = await githubChannel({ fetch: gh.fetchImpl }).connect({ token: "ghp_x" }, rec.events);
    await until(() => rec.messages.length === 2);
    expect(rec.messages[0]).toMatchObject({
      platformId: "rc:21@20",
      text: "(on `src/cache.ts` line 4)\n\nWhy a Map here?",
      replyTo: "rc:20@20",
      addressedToBot: true,
    });
    expect(rec.messages[1]).toMatchObject({ platformId: "rv:5", text: "tests please", addressedToBot: true });

    const sent = await connection.send({
      chat: { platformId: "o/r#8", kind: "thread" },
      text: "Keys are ids.",
      replyTo: "rc:21@20",
    });
    expect(sent).toEqual({ kind: "sent", platformId: "rc:22@20" });
    expect(gh.calls.find((c) => c.path === "/repos/o/r/pulls/8/comments/20/replies")?.body).toEqual({
      body: "Keys are ids.",
    });
    await connection.close();
  });

  it("posts other replies as issue comments, drops files, and maps refusals", async () => {
    const gh = fakeGitHub({
      "POST /repos/o/r/issues/7/comments": () => Response.json({ id: 31 }, { status: 201 }),
      "POST /repos/o/r/issues/9/comments": () => Response.json({ message: "Not Found" }, { status: 404 }),
    });
    const connection = await githubChannel({ fetch: gh.fetchImpl }).connect({ token: "ghp_x" }, recorder().events);
    const chat = { platformId: "o/r#7", kind: "thread" as const };
    expect(await connection.send({ chat, text: "Found it.", replyTo: "ic:13", files: [{ path: "/x.png" }] })).toEqual({
      kind: "sent",
      platformId: "ic:31",
      degraded: ["files_dropped"],
    });
    expect(await connection.send({ chat, text: "", files: [{ path: "/x.png" }] })).toMatchObject({
      kind: "failed",
      retryable: false,
    });
    expect(await connection.send({ chat: { platformId: "o/r#9", kind: "thread" }, text: "hi" })).toMatchObject({
      kind: "failed",
      code: "chat_gone",
    });
    await connection.close();
  });

  it("reacts 👀 while working and swaps it for 🚀 once answered", async () => {
    const gh = fakeGitHub({
      "GET /repos/o/r/issues/comments/13/reactions": [
        { id: 70, content: "eyes", user: ANA },
        { id: 71, content: "eyes", user: ME },
      ],
    });
    const connection = await githubChannel({ fetch: gh.fetchImpl }).connect({ token: "ghp_x" }, recorder().events);
    const chat = { platformId: "o/r#7", kind: "thread" as const };
    await connection.react(chat, "ic:13", "processing");
    await connection.react(chat, "ic:13", "done");
    const writes = gh.calls.filter((c) => c.method !== "GET" || c.path.includes("reactions"));
    expect(writes.map((c) => `${c.method} ${c.path}${c.body ? ` ${c.body.content}` : ""}`)).toEqual([
      "POST /repos/o/r/issues/comments/13/reactions eyes",
      "GET /repos/o/r/issues/comments/13/reactions?content=eyes&per_page=100",
      // Only its own 👀 goes; Ana's stays.
      "DELETE /repos/o/r/issues/comments/13/reactions/71",
      "POST /repos/o/r/issues/comments/13/reactions rocket",
    ]);
    // A review summary takes no reactions: nothing is called.
    const before = gh.calls.length;
    await connection.react(chat, "rv:5", "processing");
    expect(gh.calls.length).toBe(before);
    await connection.close();
  });

  it("stops and says so when the token is revoked", async () => {
    const gh = fakeGitHub({
      "GET /notifications": () => Response.json({ message: "Bad credentials" }, { status: 401 }),
    });
    const rec = recorder();
    await githubChannel({ fetch: gh.fetchImpl }).connect({ token: "ghp_x" }, rec.events);
    await until(() => rec.states.length > 0);
    expect(rec.states).toEqual([{ kind: "error", code: "credentials_revoked" }]);
  });
});
