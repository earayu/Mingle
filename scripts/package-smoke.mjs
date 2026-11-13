// Smoke-tests a built installer package: unpack it, find the bundled Node.js
// and Mingle CLI inside, then check that `mingle --version` prints and that
// `mingle start` serves /v1/health. Used by the release workflow; can also be
// run by hand on a downloaded artifact:
//
//   node scripts/package-smoke.mjs desktop/build/darwin-arm64/*.dmg
//
// Supported: .dmg (needs macOS), .tar.gz and .deb (Linux), .exe (Windows —
// installs silently to %LOCALAPPDATA%\Programs\Mingle; run on Windows, x64).
import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const { positionals } = parseArgs({ allowPositionals: true });
if (!positionals.length) {
  console.error("usage: node scripts/package-smoke.mjs <artifact> [<artifact>...]");
  process.exit(2);
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Find the bundled node binary and the compiled CLI entry inside an unpacked app. */
function locate(root) {
  let nodeBin;
  let entry;
  for (const path of walk(root)) {
    const base = basename(path);
    if (!nodeBin && /^node(\.exe)?$/.test(base) && /(^|[\\/])bin[\\/]?$/.test(path.slice(0, -base.length))) {
      nodeBin = path;
    }
    if (!entry && base === "main.js" && path.includes(join("dist", "cli"))) entry = path;
  }
  if (!nodeBin || !entry) throw new Error(`no bundled node/CLI found under ${root}`);
  return { nodeBin, entry };
}

async function unpack(artifact, work) {
  if (artifact.endsWith(".tar.gz")) {
    const dir = join(work, "tar");
    mkdirSync(dir, { recursive: true });
    await run("tar", ["-xzf", artifact, "-C", dir]);
    return dir;
  }
  if (artifact.endsWith(".deb")) {
    const dir = join(work, "deb");
    await run("dpkg-deb", ["-x", artifact, dir]);
    return dir;
  }
  if (artifact.endsWith(".exe")) {
    if (process.platform !== "win32") throw new Error(".exe installs only on Windows");
    await run(artifact, ["/S"], { timeout: 180_000 });
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA is not set");
    return join(local, "Programs", "Mingle");
  }
  throw new Error(`unsupported artifact: ${artifact}`);
}

async function checkVersion(nodeBin, entry) {
  const { stdout } = await run(nodeBin, [entry, "--version"], { timeout: 30_000 });
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`--version printed ${JSON.stringify(version)}`);
  const expected = process.env.MINGLE_EXPECTED_VERSION;
  if (expected && version !== expected)
    throw new Error(`--version printed ${JSON.stringify(version)}, expected ${JSON.stringify(expected)}`);
  console.log(`  --version: ${version}`);
}

async function checkStart(nodeBin, entry, work) {
  const home = join(work, "home");
  const port = 20000 + Math.floor(Math.random() * 30000);
  const child = spawn(nodeBin, [entry, "start", "--no-open", "--stop-on-stdin-close", "--port", String(port)], {
    env: { ...process.env, MINGLE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    const deadline = Date.now() + 45_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`mingle start exited early:\n${log}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
        if (res.ok) {
          console.log(`  start: /v1/health ok on :${port}`);
          return;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`mingle start did not become healthy:\n${log}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  } finally {
    child.stdin.end();
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await new Promise((r) => child.once("exit", r));
    clearTimeout(killer);
  }
}

for (const artifact of positionals) {
  console.log(`smoke: ${artifact}`);
  const work = mkdtempSync(join(tmpdir(), `mingle-smoke-${basename(artifact)}-`));
  let dmgMount;
  try {
    let root;
    if (artifact.endsWith(".dmg")) {
      if (process.platform !== "darwin") throw new Error(".dmg needs macOS (hdiutil)");
      dmgMount = join(work, "mnt");
      await run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", dmgMount, artifact]);
      root = dmgMount;
    } else {
      root = await unpack(artifact, work);
    }
    const { nodeBin, entry } = locate(root);
    await checkVersion(nodeBin, entry);
    await checkStart(nodeBin, entry, work);
    console.log("  ok");
  } finally {
    if (dmgMount) await run("hdiutil", ["detach", dmgMount, "-quiet"]).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}
