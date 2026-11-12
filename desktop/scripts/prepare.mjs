// Stages what the desktop app ships before `go tool mygo build`:
//   resources/mingle/                 Mingle's build and its production dependencies
//   resources/darwin-<arch>/node/     the Node.js runtime, pinned and checksummed
//
// Usage: node desktop/scripts/prepare.mjs [--skip-build] [--arch arm64|x64|all]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const NODE_VERSION = "24.22.3";
/** From https://nodejs.org/dist/v24.22.3/SHASUMS256.txt */
const NODE_SHA256 = {
  arm64: "ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd",
  x64: "977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7",
};
const GO_ARCH = { arm64: "arm64", x64: "amd64" };

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(desktop, "..");
const resources = join(desktop, "resources");
const cache = join(desktop, ".cache");
const { values } = parseArgs({
  options: { "skip-build": { type: "boolean" }, arch: { type: "string", default: process.arch } },
});
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

// 1. Mingle itself, with a flat node_modules (no symlinks inside the signed bundle).
if (!values["skip-build"]) run("pnpm", ["build"]);
const stage = join(resources, "mingle");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist"), join(stage, "dist"), { recursive: true });
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "LICENSE"]) {
  cpSync(join(root, file), join(stage, file));
}
run(
  "pnpm",
  ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted", "--silent"],
  stage,
);
// Native prebuilds for other systems are dead weight in a macOS app.
for (const entry of readdirSync(join(stage, "node_modules"), { recursive: true, withFileTypes: true })) {
  if (!entry.isDirectory() || !/(^|[-_])(win32|windows|linux|android|freebsd)([-_]|$)/.test(entry.name)) continue;
  if (/[/\\](prebuilds|native)([/\\]|$)/.test(entry.parentPath))
    rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
}
rmSync(join(stage, "pnpm-lock.yaml"));
rmSync(join(stage, "pnpm-workspace.yaml"));

// 2. Node.js for each architecture asked for.
const arches = values.arch === "all" ? ["arm64", "x64"] : [values.arch];
mkdirSync(cache, { recursive: true });
for (const arch of arches) {
  if (!NODE_SHA256[arch]) throw new Error(`no Node.js build pinned for ${arch}`);
  const name = `node-v${NODE_VERSION}-darwin-${arch}`;
  const tarball = join(cache, `${name}.tar.gz`);
  if (!existsSync(tarball)) {
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${name}.tar.gz`);
    if (!response.ok) throw new Error(`Node.js download failed: HTTP ${response.status}`);
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));
  }
  const sum = createHash("sha256").update(readFileSync(tarball)).digest("hex");
  if (sum !== NODE_SHA256[arch]) {
    rmSync(tarball);
    throw new Error(`Node.js checksum mismatch for ${name}`);
  }
  const target = join(resources, `darwin-${GO_ARCH[arch]}`, "node");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(join(target, "bin"), { recursive: true });
  run("tar", ["-xzf", tarball, "-C", join(target, "bin"), "--strip-components=2", `${name}/bin/node`]);
  run("tar", ["-xzf", tarball, "-C", target, "--strip-components=1", `${name}/LICENSE`]);
}
console.log(`staged Mingle with Node.js ${NODE_VERSION} (${arches.join(", ")})`);
