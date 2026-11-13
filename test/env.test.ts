import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ScriptedTurn } from "@botiverse/oar/testing";
import { afterEach, describe, expect, it } from "vitest";
import { envRef } from "../src/core/env.ts";
import { renderManual } from "../src/core/manual.ts";
import { memorySecrets, type SecretStore } from "../src/platform/secrets.ts";
import { messageIds, type Rig, rig, runCli, until } from "./helpers.ts";

/** An agent's own environment variables (docs/spec.md 3, 4.4). */

const SECRET = "https://hooks.example.test/T000/s3cr3t-value";

let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
});

/** Print a variable from a shell with the session's environment, as the agent's commands do. */
const readInShell = (env: Record<string, string>, name: string) =>
  new Promise<string>((resolve, reject) => {
    const [file, args] =
      process.platform === "win32"
        ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::Out.Write($env:${name})`]]
        : ["sh", ["-c", `printf '%s' "$${name}"`]];
    execFile(file as string, args as string[], { env: { ...process.env, ...env } }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.replace(/\r\n/g, "\n")),
    );
  });

/** A rig whose agent answers every message with what its shell prints for `$NAME`. */
async function echoing(name: string, extra: Parameters<typeof rig>[1] = {}) {
  const seen: ScriptedTurn["options"][] = [];
  const r = await rig(async (t) => {
    seen.push(t.options);
    const env = t.options.env as Record<string, string>;
    const value = await readInShell(env, name);
    for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], value || "(unset)");
  }, extra);
  return { r, seen };
}

describe("agent env API", () => {
  it("stores values only in the secret store and never returns them", async () => {
    const secrets = memorySecrets();
    current = await rig(async () => {}, { secrets });
    const { agentId } = current;

    const put = await current.admin("PUT", `/v1/admin/agents/${agentId}/env/DAILY_WEBHOOK_URL`, { value: SECRET });
    expect(put).toEqual({ status: 200, json: { ok: true } });
    expect(JSON.parse((await secrets.get(envRef(agentId, "DAILY_WEBHOOK_URL"))) as string)).toBe(SECRET);

    const list = await current.admin("GET", `/v1/admin/agents/${agentId}/env`);
    expect(list.status).toBe(200);
    expect(list.json).toEqual([{ name: "DAILY_WEBHOOK_URL", updatedAt: expect.any(Number), missing: false }]);
    expect(JSON.stringify(list.json)).not.toContain("s3cr3t");
    const agent = await current.admin("GET", `/v1/admin/agents/${agentId}`);
    expect(JSON.stringify(agent.json)).not.toContain("s3cr3t");
    // SQLite has the name and nothing else.
    const { db } = current.mingle.options.paths;
    for (const file of [db, `${db}-wal`].filter((f) => existsSync(f))) {
      expect(readFileSync(file).includes("s3cr3t")).toBe(false);
    }

    // Replacing keeps one entry.
    await current.admin("PUT", `/v1/admin/agents/${agentId}/env/DAILY_WEBHOOK_URL`, { value: "second" });
    expect((await current.admin("GET", `/v1/admin/agents/${agentId}/env`)).json).toHaveLength(1);

    expect((await current.admin("DELETE", `/v1/admin/agents/${agentId}/env/DAILY_WEBHOOK_URL`)).status).toBe(200);
    expect(await secrets.get(envRef(agentId, "DAILY_WEBHOOK_URL"))).toBeUndefined();
    expect((await current.admin("GET", `/v1/admin/agents/${agentId}/env`)).json).toEqual([]);
    const again = await current.admin("DELETE", `/v1/admin/agents/${agentId}/env/DAILY_WEBHOOK_URL`);
    expect(again).toMatchObject({ status: 404, json: { error: "env_not_found" } });
  });

  it("rejects reserved, system and malformed names, and empty values", async () => {
    current = await rig(async () => {});
    const put = (name: string, value: unknown = "v") =>
      current?.admin("PUT", `/v1/admin/agents/${current.agentId}/env/${name}`, { value });
    expect((await put("MINGLE_TOKEN"))?.json).toMatchObject({ error: "env_name_reserved" });
    expect((await put("MINGLE_API"))?.json).toMatchObject({ error: "env_name_reserved" });
    expect((await put("PATH"))?.json).toMatchObject({ error: "env_name_system" });
    expect((await put("HOME"))?.json).toMatchObject({ error: "env_name_system" });
    expect((await put("LD_PRELOAD"))?.json).toMatchObject({ error: "env_name_system" });
    expect((await put("lower_case"))?.json).toMatchObject({ error: "env_name_invalid" });
    expect((await put("1ST"))?.json).toMatchObject({ error: "env_name_invalid" });
    expect((await put("OK_NAME", ""))?.json).toMatchObject({ error: "env_value_required" });
    expect((await put("OK_NAME", 42))?.json).toMatchObject({ error: "env_value_required" });
    expect((await put("OK_NAME", "x".repeat(33 * 1024)))?.json).toMatchObject({ error: "env_value_too_large" });
    expect((await current.admin("GET", `/v1/admin/agents/${current.agentId}/env`)).json).toEqual([]);
  });

  it("reports a value gone from the secret store as missing", async () => {
    const secrets = memorySecrets();
    current = await rig(async () => {}, { secrets });
    await current.admin("PUT", `/v1/admin/agents/${current.agentId}/env/GITHUB_TOKEN`, { value: "ghp_x" });
    await secrets.delete(envRef(current.agentId, "GITHUB_TOKEN"));
    expect((await current.admin("GET", `/v1/admin/agents/${current.agentId}/env`)).json).toEqual([
      { name: "GITHUB_TOKEN", updatedAt: expect.any(Number), missing: true },
    ]);
  });

  it("deletes the values with the agent", async () => {
    const secrets = memorySecrets();
    current = await rig(async () => {}, { secrets });
    const { agentId } = current;
    await current.admin("PUT", `/v1/admin/agents/${agentId}/env/FOO`, { value: "bar" });
    await current.admin("DELETE", `/v1/admin/agents/${agentId}`);
    expect(await secrets.get(envRef(agentId, "FOO"))).toBeUndefined();
  });

  it("does not leak a value when the secret store fails", async () => {
    const lines: string[] = [];
    const inner = memorySecrets();
    const failing: SecretStore = {
      ...inner,
      set: async (ref, value) => {
        if (ref.startsWith("env:")) throw new Error(`security add-generic-password -w ${value}`);
        await inner.set(ref, value);
      },
    };
    current = await rig(async () => {}, { secrets: failing, log: (line) => lines.push(line) });
    const put = await current.admin("PUT", `/v1/admin/agents/${current.agentId}/env/FOO`, { value: SECRET });
    expect(put).toMatchObject({ status: 500, json: { error: "env_save_failed" } });
    expect(JSON.stringify(put.json)).not.toContain("s3cr3t");
    expect(lines.join("\n")).not.toContain("s3cr3t");
    expect((await current.admin("GET", `/v1/admin/agents/${current.agentId}/env`)).json).toEqual([]);
  });
});

describe("agent env in the session", () => {
  it("reaches the agent's shell: echo $FOO prints the value", async () => {
    const lines: string[] = [];
    const { r, seen } = await echoing("FOO", { log: (line) => lines.push(line) });
    current = r;
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/env/FOO`, { value: SECRET });
    r.channel.receive({ text: "what is FOO?" });
    expect((await until(() => r.channel.sent[0])).text).toBe(SECRET);

    const options = seen.at(-1);
    // The guide names the variable and never carries its value.
    expect(options?.appendSystemPrompt).toContain("`FOO`");
    expect(options?.appendSystemPrompt).not.toContain("s3cr3t");
    // Logs never carry the value either.
    expect(lines.join("\n")).not.toContain("s3cr3t");
  });

  it("keeps Mingle's own variables over the agent's", async () => {
    const secrets = memorySecrets();
    const { r, seen } = await echoing("MINGLE_TOKEN", { secrets });
    current = r;
    // Bypass the API's check, as a hand-edited database would.
    r.mingle.store.putEnvName(r.agentId, "MINGLE_TOKEN");
    await secrets.set(envRef(r.agentId, "MINGLE_TOKEN"), JSON.stringify("hijacked"));
    await r.mingle.runtime(r.agentId)?.restart();
    r.channel.receive({ text: "hi" });
    await until(() => r.channel.sent[0]); // the CLI still authenticates
    expect(seen.at(-1)?.env?.MINGLE_TOKEN).not.toBe("hijacked");
    expect(r.channel.sent[0]?.text).not.toBe("hijacked");
  });

  it("keeps a multi-line value whole", async () => {
    const { r } = await echoing("PEM");
    current = r;
    const pem = "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----";
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/env/PEM`, { value: pem });
    r.channel.receive({ text: "pem?" });
    expect((await until(() => r.channel.sent[0])).text).toBe(pem);
  });

  it("applies a change from the next message, without cutting the current turn short", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let turn = 0;
    const seen: (string | undefined)[] = [];
    const resumed: (string | undefined)[] = [];
    current = await rig(async (t) => {
      turn++;
      const env = t.options.env as Record<string, string>;
      seen.push(env.FOO);
      resumed.push(t.options.resume);
      if (turn === 1) await gate;
      for (const id of messageIds(t.input)) await runCli(env, ["message", "reply", id], env.FOO ?? "(unset)");
    });
    const r = current;
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/env/FOO`, { value: "old" });
    r.channel.receive({ text: "first" });
    await until(() => turn === 1);
    // Changed mid-turn: the turn finishes with what it started with.
    await r.admin("PUT", `/v1/admin/agents/${r.agentId}/env/FOO`, { value: "new" });
    expect(r.mingle.runtime(r.agentId)?.busy).toBe(true);
    release();
    await until(() => r.channel.sent[0]);
    expect(r.channel.sent[0]?.text).toBe("old");
    // Sent while the turn is still ending, it would be steered into that turn instead.
    await until(() => r.mingle.runtime(r.agentId)?.busy === false);

    r.channel.receive({ text: "second" });
    await until(() => r.channel.sent[1]);
    expect(r.channel.sent[1]?.text).toBe("new");
    expect(seen).toEqual(["old", "new"]);
    // The new process resumes the same conversation.
    expect(resumed[1]).toBe(r.mingle.store.agent(r.agentId)?.sessionId);
    expect(resumed[1]).toBeTruthy();
  });

  it("drops the variables and their names for a harness whose shell gets no environment", async () => {
    const seen: ScriptedTurn["options"][] = [];
    current = await rig(
      async (t) => {
        seen.push(t.options);
      },
      { wrap: (harness) => ({ ...harness, acceptsEnv: () => false }) },
    );
    await current.admin("PUT", `/v1/admin/agents/${current.agentId}/env/FOO`, { value: SECRET });
    current.channel.receive({ text: "hi" });
    await until(() => seen.length > 0);
    expect(seen[0]?.env).not.toHaveProperty("FOO");
    expect(JSON.stringify(seen[0])).not.toContain("s3cr3t");
    expect(seen[0]?.appendSystemPrompt).not.toContain("FOO");
  });
});

describe("agent env in the guide", () => {
  it("names the variables, never values, on every platform", () => {
    expect(renderManual("Alex", "", "darwin")).not.toContain("Environment variables set for you");
    const unix = renderManual("Alex", "", "darwin", ["DAILY_WEBHOOK_URL", "GITHUB_TOKEN"]);
    expect(unix).toContain("`DAILY_WEBHOOK_URL`, `GITHUB_TOKEN`");
    expect(unix).toContain("`$NAME`");
    expect(renderManual("Alex", "", "win32", ["FOO"])).toContain("`$env:NAME`");
  });
});
