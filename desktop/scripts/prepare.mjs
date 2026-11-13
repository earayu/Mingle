// Stages what the desktop app ships before `go tool mygo build`, in mygo's platform
// resource directories, which each app merges into its resources:
//   resources/<os>/core/              Mingle's build and its production dependencies,
//                                     with only that system's native prebuilds
//   resources/<os>-<arch>/node/       the Node.js runtime, pinned and checksummed
//
// Usage: node desktop/scripts/prepare.mjs [--skip-build] [--platform darwin/arm64,linux/amd64,…]
// The platforms are mygo's -platform targets; the default is this machine's.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const NODE_VERSION = "24.22.3";
/** From https://nodejs.org/dist/v24.22.3/SHASUMS256.txt */
const NODE_BUILDS = {
  "darwin/arm64": ["darwin-arm64.tar.gz", "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd"],
  "darwin/amd64": ["darwin-x64.tar.gz", "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7"],
  "linux/arm64": ["linux-arm64.tar.gz", "261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8"],
  "linux/amd64": ["linux-x64.tar.gz", "061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2"],
  "windows/arm64": ["win-arm64.zip", "b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14"],
  "windows/amd64": ["win-x64.zip", "e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f"],
};
/** How packages name each system in their prebuild directories. */
const NATIVE_NAMES = {
  darwin: ["darwin", "mac", "macos", "osx"],
  linux: ["linux"],
  windows: ["win32", "windows", "win"],
};

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(desktop, "..");
const resources = join(desktop, "resources");
const cache = join(desktop, ".cache");
const here = `${{ darwin: "darwin", linux: "linux", win32: "windows" }[process.platform]}/${{ arm64: "arm64", x64: "amd64" }[process.arch]}`;
const { values } = parseArgs({
  options: { "skip-build": { type: "boolean" }, platform: { type: "string", default: here } },
});
const platforms = values.platform.split(",").map((p) => p.trim());
for (const p of platforms) if (!NODE_BUILDS[p]) throw new Error(`no Node.js build pinned for ${p}`);
const systems = [...new Set(platforms.map((p) => p.split("/")[0]))];
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" && cmd === "pnpm" });

// Start clean: a stale directory of another layout would ship twice and fail the build.
for (const entry of readdirSync(resources)) {
  if (entry === "mingle" || entry === "core" || /^(darwin|linux|windows)(-|$)/.test(entry)) {
    rmSync(join(resources, entry), { recursive: true, force: true });
  }
}

// 1. Mingle, with a flat node_modules (no symlinks inside the signed bundle).
if (!values["skip-build"]) run("pnpm", ["build"]);
const base = join(cache, "mingle");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
cpSync(join(root, "dist"), join(base, "dist"), { recursive: true });
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "LICENSE"]) {
  cpSync(join(root, file), join(base, file));
}
run(
  "pnpm",
  ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted", "--silent"],
  base,
);
rmSync(join(base, "pnpm-lock.yaml"));
rmSync(join(base, "pnpm-workspace.yaml"));

for (const system of systems) {
  // Not "mingle": on Linux the app's executable has that name, in the same directory.
  const stage = join(resources, system, "core");
  mkdirSync(dirname(stage), { recursive: true });
  cpSync(base, stage, { recursive: true });
  // Native prebuilds for other systems are dead weight, and unsigned code to macOS.
  const others = Object.entries(NATIVE_NAMES)
    .filter(([name]) => name !== system)
    .flatMap(([, names]) => names)
    .join("|");
  const foreign = new RegExp(`(^|[-_])(${others}|android|freebsd)([-_]|$)`);
  for (const entry of readdirSync(join(stage, "node_modules"), { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory() || !foreign.test(entry.name)) continue;
    if (/[/\\](prebuilds|native)([/\\]|$)/.test(entry.parentPath))
      rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
  }
}

// 2. Node.js for each platform.
mkdirSync(cache, { recursive: true });
for (const platform of platforms) {
  const [suffix, sha256] = NODE_BUILDS[platform];
  const name = `node-v${NODE_VERSION}-${suffix.replace(/\.(tar\.gz|zip)$/, "")}`;
  const archive = join(cache, `node-v${NODE_VERSION}-${suffix}`);
  if (!existsSync(archive)) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${suffix}`);
    if (!response.ok) throw new Error(`Node.js download failed: HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (sum !== sha256) {
    rmSync(archive);
    throw new Error(`Node.js checksum mismatch for ${name}`);
  }
  const target = join(resources, platform.replace("/", "-"), "node");
  mkdirSync(join(target, "bin"), { recursive: true });
  if (suffix.endsWith(".zip")) {
    // Windows: node.exe sits at the top of the archive. The app looks in node/bin.
    run("unzip", ["-q", "-j", "-o", archive, `${name}/node.exe`, `${name}/LICENSE`, "-d", target]);
    cpSync(join(target, "node.exe"), join(target, "bin", "node.exe"));
    rmSync(join(target, "node.exe"));
  } else {
    run("tar", ["-xzf", archive, "-C", join(target, "bin"), "--strip-components=2", `${name}/bin/node`]);
    run("tar", ["-xzf", archive, "-C", target, "--strip-components=1", `${name}/LICENSE`]);
  }
}
console.log(`staged Mingle (${systems.join(", ")}) with Node.js ${NODE_VERSION} (${platforms.join(", ")})`);
