import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { remoteId } from "../src/core/remote.ts";
import { Remotes, type RemoteTransport } from "../src/core/remotes.ts";
import { remoteHome, shellQuote, sshArgs, sshTarget } from "../src/platform/ssh.ts";
import { remoteRequest } from "../src/remote/control.ts";
import { type RemoteRequest, type RemoteResponse, RpcClient, serveRpc } from "../src/remote/wire.ts";
import { eventually, rig, until } from "./helpers.ts";

describe("SSH transport", () => {
  it("quotes remote arguments and forbids SSH option injection", () => {
    for (const bad of ["-oProxyCommand=evil", "host;evil", "host\ncommand", "user@host command", "$(id)", ""])
      expect(() => sshTarget(bad)).toThrow();
    for (const good of ["dev", "user@dev.example", "user@[::1]"]) expect(sshTarget(good)).toBe(good);
    const value = "/tmp/a 'quoted' $(false); with spaces";
    if (process.platform !== "win32")
      expect(spawnSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" }).stdout).toBe(value);
    const args = sshArgs("dev", ["node", value]);
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args.slice(-3)).toEqual(["--", "dev", `'node' ${shellQuote(value)}`]);
    expect(remoteHome("~/agents")).toBe("~/agents");
    for (const bad of ["relative", "/tmp/a\nother", null]) expect(() => remoteHome(bad)).toThrow();
  });

  it("multiplexes responses, rejects pending requests on disconnect, and times out", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new RpcClient(input, output);
    const slow = Promise.withResolvers<RemoteResponse>();
    serveRpc(output, input, async (request) =>
      request.path === "/slow" ? slow.promise : { status: 200, body: request.path },
    );
    const pending = client.request({ method: "GET", path: "/slow" });
    const rejection = expect(pending).rejects.toThrow("closed");
    expect((await client.request({ method: "GET", path: "/fast" })).body).toBe("/fast");
    await expect(client.request({ method: "GET", path: "/slow" }, 10)).rejects.toThrow("timed out");
    client.close();
    await rejection;
    slow.resolve({ status: 200, body: "late" });
  });

  it("rejects unsafe paths before reading tokens", async () => {
    for (const path of [
      "https://example.com",
      "/v1/agent/whoami",
      "/v1/admin/ssh/hosts",
      "/v1/admin/%73sh/hosts",
      "/v1/admin/%2e%2e/health",
      "/v1/admin/agents/a/open-home",
      "/v1/admin/agents/a/chat/files/f1/reveal",
    ]) {
      expect((await remoteRequest("/nonexistent", { method: "GET", path })).status).toBe(400);
    }
  });
});

describe("remote management", () => {
  it("does not let an older poll overwrite a completed create or delete", async () => {
    const home = mkdtempSync(join(tmpdir(), "mingle-remote-race-"));
    const pending = Promise.withResolvers<RemoteResponse>();
    let polls = 0;
    let agents: Record<string, unknown>[] = [];
    const manager = new Remotes(home, {
      install: async () => {},
      prepare: async () => ({ home: "/remote/data", runtime: "/remote/runtime" }),
      connect: () => ({
        close: () => {},
        request: async (request) => {
          if (request.method === "GET") {
            polls++;
            return polls === 1 ? pending.promise : { status: 200, body: { agents } };
          }
          if (request.method === "POST") {
            const agent = { id: "a1", slug: "alex", harness: "scripted", connections: [] };
            agents = [agent];
            return { status: 201, body: agent };
          }
          agents = [];
          return { status: 200, body: { ok: true } };
        },
      }),
    });
    try {
      const host = await manager.add({ host: "fixture", home: "~/data" });
      const reading = manager.agents();
      await until(() => polls === 1);
      await manager.request(host.id, { method: "POST", path: "/v1/admin/agents", body: { harness: "scripted" } });
      pending.resolve({ status: 200, body: { agents: [] } });
      expect(await reading).toMatchObject([{ id: remoteId(host.id, "a1") }]);
      expect(polls).toBe(2);
      await manager.request(host.id, { method: "DELETE", path: "/v1/admin/agents/a1" });
      expect(JSON.parse(readFileSync(join(home, "ssh-hosts.json"), "utf8")).agents[host.id]).toEqual([]);
    } finally {
      manager.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("authenticates locally, routes and namespaces remote resources without rewriting secrets", async () => {
    const requests: RemoteRequest[] = [];
    let available = true;
    let closed = 0;
    const agent = {
      id: "a1",
      slug: "alex",
      name: "Alex",
      harness: "scripted",
      avatar: null,
      status: "idle",
      connections: [{ id: "n1" }],
    };
    const transport: RemoteTransport = {
      install: async () => {},
      prepare: async () => ({ home: "/test/home", runtime: "/test/runtime" }),
      connect: () => ({
        close: () => {
          closed++;
        },
        request: async (request) => {
          requests.push(request);
          if (!available) throw new Error("offline");
          const path = request.path.split("?")[0];
          if (path === "/v1/admin/status") return { status: 200, body: { agents: [agent] } };
          if (path === "/v1/admin/brains") return { status: 200, body: [{ id: "scripted", installJob: { id: "j1" } }] };
          if (path?.endsWith("/contacts"))
            return { status: 200, body: [{ accounts: [{ id: "u1", connection: "n1" }] }] };
          if (path?.endsWith("/access")) return { status: 200, body: [{ id: "u1", connection: "n1" }] };
          if (path === "/v1/admin/agents" || path?.endsWith("/avatar")) return { status: 201, body: agent };
          if (path?.endsWith("/onboarding")) return { status: 200, body: { id: "o1" } };
          return { status: 200, body: { ok: true } };
        },
      }),
    };
    const local = await rig(async () => {}, { remoteTransport: transport });
    try {
      const unauthorized = await fetch(`${local.url}/v1/admin/ssh/hosts`, {
        method: "POST",
        body: JSON.stringify({ host: "dev", home: "~/data" }),
      });
      expect(unauthorized.status).toBe(401);
      const added = await local.admin("POST", "/v1/admin/ssh/hosts", { host: "dev", home: "~/data" });
      expect(added.status).toBe(201);
      const host = (added.json as { id: string }).id;
      const ns = (id: string) => remoteId(host, id);
      const brains = await local.admin("GET", `/v1/admin/ssh/${host}/brains?fresh=1`);
      expect(brains.json).toEqual([{ id: ns("scripted"), installJob: { id: ns("j1") } }]);
      const secret = `${host}~secret-is-opaque`;
      const created = await local.admin("POST", "/v1/admin/agents", {
        name: "Alex",
        harness: ns("scripted"),
        role: secret,
      });
      expect(created.status).toBe(201);
      expect(created.json).toMatchObject({
        id: ns("a1"),
        harness: ns("scripted"),
        connections: [{ id: ns("n1") }],
        remote: { host: "dev", reachable: true },
      });
      expect(requests.at(-1)?.body).toEqual({ name: "Alex", harness: "scripted", role: secret });
      expect(local.mingle.store.agents()).toHaveLength(1);
      expect(
        (await local.admin("PATCH", `/v1/admin/agents/${local.agentId}`, { harness: ns("scripted") })).status,
      ).toBe(400);
      await local.admin("PUT", `/v1/admin/agents/${ns("a1")}/env/TOKEN`, { value: secret });
      expect(requests.at(-1)).toMatchObject({ path: "/v1/admin/agents/a1/env/TOKEN", body: { value: secret } });
      await local.admin("POST", `/v1/admin/connections/${ns("n1")}/reconnect`);
      expect(requests.at(-1)?.path).toBe("/v1/admin/connections/n1/reconnect");
      expect((await local.admin("GET", `/v1/admin/agents/${ns("a1")}/contacts`)).json).toEqual([
        { accounts: [{ id: "u1", connection: ns("n1") }] },
      ]);
      expect((await local.admin("GET", `/v1/admin/agents/${ns("a1")}/access`)).json).toEqual([
        { id: "u1", connection: ns("n1") },
      ]);
      expect(
        (await local.admin("POST", `/v1/admin/agents/${ns("a1")}/onboarding`, { platform: "telegram" })).json,
      ).toEqual({ id: ns("o1") });
      const avatar = await fetch(`${local.url}/v1/admin/agents/${ns("a1")}/avatar`, {
        method: "PUT",
        headers: { authorization: `Bearer ${local.mingle.adminToken}`, "content-type": "image/png" },
        body: Buffer.from("fake-image"),
      });
      expect(avatar.status).toBe(201);
      expect(requests.at(-1)?.binary).toBe(Buffer.from("fake-image").toString("base64"));
      const status = await local.admin("GET", "/v1/admin/status");
      expect((status.json as { agents: unknown[] }).agents).toHaveLength(2);
      // Windows chmod does not implement POSIX read permissions.
      if (process.platform !== "win32") expect(statSync(join(local.home, "ssh-hosts.json")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(local.home, "ssh-hosts.json"), "utf8")).not.toContain(secret);
      available = false;
      const cached = await local.admin("GET", "/v1/admin/status");
      expect((cached.json as { agents: unknown[] }).agents[1]).toMatchObject({
        status: "idle",
        remote: { reachable: false },
      });
      available = true;
      expect((await local.mingle.remotes.agents())[0]).toMatchObject({ remote: { reachable: true } });
    } finally {
      await local.close();
    }
    expect(closed).toBe(2);
  });

  it("preserves private chat file uploads (including JSON and filenames) and non-image downloads over SSH", async () => {
    const remote = await rig(async () => {});
    writeFileSync(
      join(remote.home, "runtime.json"),
      JSON.stringify({ url: remote.url, adminToken: remote.mingle.adminToken }),
    );
    const transport: RemoteTransport = {
      install: async () => {},
      prepare: async () => ({ home: remote.home, runtime: resolve(".") }),
      connect: () => ({
        request: (request) => remoteRequest(remote.home, request),
        close: () => {},
      }),
    };
    const local = await rig(async () => {}, { remoteTransport: transport });
    try {
      const added = await local.admin("POST", "/v1/admin/ssh/hosts", { host: "dev", home: remote.home });
      const host = (added.json as { id: string }).id;
      const agent = remoteId(host, remote.agentId);

      // Upload a JSON file (with non-canonical whitespace): must keep raw bytes and filename.
      const rawJson = '{\n  "hello": "world"\n}\n';
      const uploaded = await fetch(`${local.url}/v1/admin/agents/${agent}/chat/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${local.mingle.adminToken}`,
          "content-type": "application/json",
          "x-file-name": encodeURIComponent("config.json"),
        },
        body: rawJson,
      });
      expect(uploaded.status).toBe(201);
      const up = (await uploaded.json()) as { id: string; name: string; size: number };
      expect(up.name).toBe("config.json");
      expect(up.size).toBe(Buffer.byteLength(rawJson));

      // Send it in private chat and download it back through the SSH gateway.
      const sent = await local.admin("POST", `/v1/admin/agents/${agent}/chat`, { text: "here", files: [up.id] });
      expect(sent.status).toBe(201);
      const fileId = (sent.json as { files: { id: string }[] }).files[0]?.id as string;
      const downloaded = await fetch(`${local.url}/v1/admin/agents/${agent}/chat/files/${fileId}`, {
        headers: { authorization: `Bearer ${local.mingle.adminToken}` },
      });
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-disposition")).toContain("config.json");
      expect(await downloaded.text()).toBe(rawJson);

      // Binary non-image file (e.g. PDF bytes with non-UTF-8 octets) survives round-trip verbatim.
      const pdfBytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x80, 0xff, 0x00, 0xfe]);
      const pdfUp = await fetch(`${local.url}/v1/admin/agents/${agent}/chat/uploads`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${local.mingle.adminToken}`,
          "content-type": "application/pdf",
          "x-file-name": encodeURIComponent("report.pdf"),
        },
        body: pdfBytes,
      });
      expect(pdfUp.status).toBe(201);
      const pdf = (await pdfUp.json()) as { id: string; name: string };
      expect(pdf.name).toBe("report.pdf");
      const pdfSent = await local.admin("POST", `/v1/admin/agents/${agent}/chat`, { text: "", files: [pdf.id] });
      const pdfFileId = (pdfSent.json as { files: { id: string }[] }).files[0]?.id as string;
      const pdfGot = await fetch(`${local.url}/v1/admin/agents/${agent}/chat/files/${pdfFileId}`, {
        headers: { authorization: `Bearer ${local.mingle.adminToken}` },
      });
      expect(pdfGot.status).toBe(200);
      expect(pdfGot.headers.get("content-type")).toBe("application/pdf");
      expect(Buffer.from(await pdfGot.arrayBuffer())).toEqual(pdfBytes);
    } finally {
      await local.close();
      await remote.close();
    }
  });

  // The fixture emulates a POSIX remote service, including its paths and graceful signals.
  it.skipIf(process.platform === "win32")(
    "keeps receiving and replying after the manager disconnects, reconnects, and restarts a crashed daemon",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "mingle-remote-supervisor-"));
      const localHome = mkdtempSync(join(tmpdir(), "mingle-remote-manager-"));
      const supervisorModule = pathToFileURL(resolve("src/remote/service.ts")).href;
      const script = `import { supervise } from ${JSON.stringify(supervisorModule)}; await supervise(${JSON.stringify(home)}, ${JSON.stringify(resolve("test/fixtures/remote-service.ts"))});`;
      const supervisor = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: "ignore",
        detached: true,
      });
      const controls: ReturnType<typeof spawn>[] = [];
      const transport: RemoteTransport = {
        install: async () => {},
        prepare: async () => ({ home, runtime: resolve(".") }),
        connect: () => {
          // Local pipes stand in for SSH; the real control program and Mingle API run unmodified.
          const child = spawn(process.execPath, ["src/remote/control.ts", home], { stdio: ["pipe", "pipe", "ignore"] });
          controls.push(child);
          const rpc = new RpcClient(child.stdout, child.stdin);
          child.on("error", (error) => rpc.close(error));
          return {
            request: (request, timeout) => rpc.request(request, timeout),
            close: () => {
              rpc.close();
              child.kill();
            },
          };
        },
      };
      let manager = new Remotes(localHome, transport);
      try {
        await until(() => existsSync(join(home, "fixture.json")), 20_000);
        const fixture = JSON.parse(readFileSync(join(home, "fixture.json"), "utf8")) as { url: string; pid: number };
        const host = await manager.add({ host: "isolated-fixture", home });
        const initial = await manager.agents();
        expect(initial).toHaveLength(1);
        const remoteAgentId = initial[0]?.id;
        const remoteToken = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")).adminToken as string;
        expect(JSON.stringify(initial)).not.toContain(remoteToken);
        manager.close();
        await until(() => controls.every((child) => child.exitCode !== null || child.signalCode !== null));
        // No manager or control channel exists when the next chat message arrives.
        await fetch(`${fixture.url}/receive`);
        await eventually(async () => {
          const state = (await (await fetch(fixture.url)).json()) as { sent: { text: string }[] };
          return state.sent.some((message) => message.text === "still here");
        });
        manager = new Remotes(localHome, transport);
        expect((await manager.agents())[0]).toMatchObject({ id: remoteAgentId, remote: { reachable: true } });
        expect(manager.list()[0]?.id).toBe(host.id);
        // A second supervisor cannot start another daemon for the same data directory.
        const duplicate = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
        await once(duplicate, "exit");
        expect(JSON.parse(readFileSync(join(home, "fixture.json"), "utf8")).pid).toBe(fixture.pid);
        process.kill(fixture.pid, "SIGTERM");
        await until(() => {
          const current = JSON.parse(readFileSync(join(home, "fixture.json"), "utf8")) as { pid: number };
          return current.pid !== fixture.pid;
        }, 20_000);
        expect((await manager.agents())[0]).toMatchObject({ remote: { reachable: true } });
      } finally {
        manager.close();
        supervisor.kill("SIGTERM");
        await once(supervisor, "exit");
        for (const child of controls) child.kill();
        rmSync(home, { recursive: true, force: true });
        rmSync(localHome, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
