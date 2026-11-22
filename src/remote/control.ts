import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type RemoteRequest, type RemoteResponse, serveRpc } from "./wire.ts";

/** Tokens stay on the host. Only the requested API result crosses SSH. */
export async function remoteRequest(home: string, request: RemoteRequest): Promise<RemoteResponse> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(request.path);
  } catch {
    decoded = "";
  }
  if (
    !/^(GET|POST|PUT|PATCH|DELETE)$/.test(request.method) ||
    !/^\/v1\/(admin\/|avatars\/|health$)/.test(decoded) ||
    decoded
      .split("?")[0]
      ?.split("/")
      .some((part) => part === "." || part === "..") ||
    decoded.includes("\\") ||
    [...decoded].some((char) => char.charCodeAt(0) < 32) ||
    /^\/v1\/admin\/ssh(?:\/|\?|$)/.test(decoded) ||
    decoded.includes("/open-home") ||
    /\/chat\/files\/[^/]+\/reveal(?:\/|\?|$)/.test(decoded)
  ) {
    return { status: 400, body: { error: "ssh_request_invalid", next: "Unsupported remote request." } };
  }
  const runtime = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as { url: string; adminToken: string };
  const url = new URL(runtime.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("invalid remote runtime address");
  const target = new URL(request.path, url.origin);
  if (target.pathname === "/v1/admin/status") target.searchParams.set("local", "1");
  const response = await fetch(target, {
    method: request.method,
    headers: {
      authorization: `Bearer ${runtime.adminToken}`,
      ...(request.binary !== undefined
        ? {
            "content-type": request.contentType ?? "application/octet-stream",
            ...(request.fileName !== undefined ? { "x-file-name": request.fileName } : {}),
          }
        : request.body === undefined
          ? {}
          : { "content-type": "application/json" }),
    },
    ...(request.binary !== undefined
      ? { body: Buffer.from(request.binary, "base64") }
      : request.body === undefined
        ? {}
        : { body: JSON.stringify(request.body) }),
    signal: AbortSignal.timeout(25_000),
    redirect: "error",
  });
  const contentType = response.headers.get("content-type") ?? "application/json";
  const disposition = response.headers.get("content-disposition") ?? undefined;
  if (contentType.startsWith("image/") || disposition?.startsWith("attachment")) {
    return {
      status: response.status,
      body: null,
      contentType,
      ...(disposition ? { disposition } : {}),
      binary: Buffer.from(await response.arrayBuffer()).toString("base64"),
    };
  }
  return {
    status: response.status,
    body: contentType.includes("json") ? await response.json() : await response.text(),
    contentType,
  };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const home = process.argv[2];
  if (!home) throw new Error("remote data directory required");
  serveRpc(process.stdin, process.stdout, (request) => remoteRequest(home, request));
}
