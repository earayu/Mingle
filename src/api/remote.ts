import type { MiddlewareHandler } from "hono";
import { MingleError } from "../core/errors.ts";
import { splitRemoteId } from "../core/remote.ts";
import type { Remotes } from "../core/remotes.ts";
import type { RemoteRequest, RemoteResponse } from "../remote/wire.ts";

export function remoteResponse(result: RemoteResponse): Response {
  return new Response(
    result.status === 204
      ? null
      : result.binary !== undefined
        ? Buffer.from(result.binary, "base64")
        : JSON.stringify(result.body),
    {
      status: result.status,
      headers: {
        "content-type": result.contentType ?? "application/json",
        ...(result.disposition ? { "content-disposition": result.disposition } : {}),
        "cross-origin-resource-policy": "same-origin",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    },
  );
}

/** Mounted after local admin authentication; only explicitly scoped requests cross SSH. */
export function remoteGateway(remotes: Remotes): MiddlewareHandler {
  return async (c, next) => {
    let host: string | undefined;
    const scope = (id: string) => {
      if (host && host !== id) throw new MingleError("ssh_scope_invalid", "A request must belong to one SSH host.");
      host = id;
    };
    let path = c.req.path;
    const explicit = /^\/v1\/admin\/ssh\/(ssh_[a-f0-9]{12})\/(.+)$/.exec(path);
    if (explicit) {
      scope(explicit[1] as string);
      path = `/v1/admin/${explicit[2]}`;
    }
    // Only resource identifiers may select a host. Role text and credential values are opaque.
    const segments = path.split("/");
    if (["agents", "connections", "onboarding", "brains", "harnesses", "jobs"].includes(segments[3] ?? "")) {
      const remote = splitRemoteId(decodeURIComponent(segments[4] ?? ""));
      if (remote) {
        scope(remote.host);
        segments[4] = encodeURIComponent(remote.id);
      }
    }
    path = segments.join("/");
    const method = c.req.method;
    let body: Record<string, unknown> | undefined;
    const agentMutation =
      (method === "POST" && path === "/v1/admin/agents") ||
      (method === "PATCH" && /^\/v1\/admin\/agents\/[^/]+$/.test(path));
    if (agentMutation) {
      const parsed: unknown = await c.req.raw.clone().json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new MingleError("invalid_json", "Pass a JSON object.");
      body = parsed as Record<string, unknown>;
      const remote = typeof body?.harness === "string" ? splitRemoteId(body.harness) : null;
      if (remote) {
        // A local agent cannot be moved by selecting a remotely namespaced harness.
        if (method === "PATCH" && !host)
          throw new MingleError("ssh_scope_invalid", "An agent cannot move between hosts.");
        scope(remote.host);
        body = { ...body, harness: remote.id };
      }
    }
    if (!host) return next();
    if (/\/open-home$|\/chat\/files\/[^/]+\/reveal$/.test(path))
      throw new MingleError("ssh_remote_home", "Open this on the remote host.");
    const request: RemoteRequest = { method, path: path + new URL(c.req.url).search };
    if (!["GET", "HEAD"].includes(method)) {
      const bytes = await c.req.raw.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) throw new MingleError("too_large", "The request is too large.", 413);
      const isUpload = /\/chat\/uploads$/.test(path);
      if (isUpload) {
        request.binary = Buffer.from(bytes).toString("base64");
        const fileName = c.req.header("x-file-name");
        const contentType = c.req.header("content-type");
        if (fileName !== undefined) request.fileName = fileName;
        if (contentType) request.contentType = contentType;
      } else if (bytes.byteLength) {
        if (c.req.header("content-type")?.includes("json"))
          request.body = body ?? JSON.parse(Buffer.from(bytes).toString());
        else request.binary = Buffer.from(bytes).toString("base64");
      }
    }
    return remoteResponse(await remotes.request(host, request));
  };
}
