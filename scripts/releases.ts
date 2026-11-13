// Release metadata and artifact verification for Mingle's GitHub Releases.
//
// The GitHub "latest release" is the single source of truth for what the
// website offers and what installed apps update to. This module is the shared
// contract between the website build, the release workflow and the website
// workflow:
//
//   node scripts/releases.ts snapshot <output.json>    freeze the latest release
//   node scripts/releases.ts check-latest <snapshot>   fail if latest moved on
//   node scripts/releases.ts verify <snapshot> <dir>   verify downloaded assets
//   node scripts/releases.ts assemble <tag> <builds-dir> <assets-dir>
//
// It is also importable (site/scripts/build.mjs uses validateRelease). No
// dependencies; runs directly on Node 24.

import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export const REPOSITORY = "earayu/Mingle";
export const REPO_URL = `https://github.com/${REPOSITORY}`;

export interface ReleaseAsset {
  id: number;
  name: string;
  size: number;
  state: string;
  browser_download_url: string;
  updated_at: string;
}

export interface Release {
  id: number;
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  assets: ReleaseAsset[];
}

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ASSET_NAME = /^[A-Za-z0-9._-]+$/;
const SHA256_LINE = /^([a-f0-9]{64}) [ *]([A-Za-z0-9._-]+)$/;
const MAX_MANIFEST = 1024 * 1024;

/** Extract the version ("1.2.0-beta.1") from a strict "v…" tag, or throw. */
export function releaseVersion(tag: string): string {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`Invalid release tag: ${JSON.stringify(tag)}`);
  const pre = match[4];
  if (pre) {
    for (const id of pre.split(".")) {
      // Semver: numeric prerelease identifiers must not have leading zeros.
      if (/^\d+$/.test(id) && id.length > 1 && id.startsWith("0")) {
        throw new Error(`Invalid prerelease identifier in tag: ${JSON.stringify(tag)}`);
      }
    }
  }
  return tag.slice(1);
}

/** The platform-arch targets the updater produces manifests for. */
export function releaseTargets(prerelease: boolean): string[] {
  return prerelease
    ? ["darwin-arm64", "darwin-amd64"]
    : ["darwin-arm64", "darwin-amd64", "windows-amd64", "windows-arm64", "linux-amd64", "linux-arm64"];
}

/** Every file a complete release must carry. Extra assets are permitted. */
export function requiredAssets(version: string, prerelease: boolean): string[] {
  const installers = [`mingle-${version}-arm64.dmg`, `mingle-${version}-amd64.dmg`];
  if (!prerelease)
    installers.push(
      `mingle-setup-${version}-amd64.exe`,
      `mingle-setup-${version}-arm64.exe`,
      `mingle_${version}_amd64.deb`,
      `mingle_${version}_arm64.deb`,
      `mingle-${version}-1.x86_64.rpm`,
      `mingle-${version}-1.aarch64.rpm`,
    );
  return [
    ...installers,
    ...releaseTargets(prerelease).flatMap((t) => [`mingle-${version}-${t}.tar.gz`, `update-${t}.json`]),
    "install.sh",
    ...(prerelease ? [] : ["install.ps1"]),
    "SHA256SUMS",
  ];
}

function fail(message: string): never {
  throw new Error(`Invalid release metadata: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateAsset(value: unknown): ReleaseAsset {
  if (!isRecord(value)) fail("asset is not an object");
  const { id, name, size, state, browser_download_url, updated_at } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) fail("asset id must be a positive integer");
  if (typeof name !== "string" || !ASSET_NAME.test(name) || name === "." || name === "..")
    fail(`asset name is unsafe: ${JSON.stringify(name)}`);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0)
    fail(`asset ${name}: size must be a positive integer`);
  if (state !== "uploaded") fail(`asset ${name}: state is ${JSON.stringify(state)}, expected "uploaded"`);
  if (typeof browser_download_url !== "string" || !browser_download_url) fail(`asset ${name}: missing download URL`);
  if (typeof updated_at !== "string" || !updated_at) fail(`asset ${name}: missing updated_at`);
  return { id, name, size, state, browser_download_url, updated_at };
}

/**
 * Validate untrusted GitHub release JSON into a Release. By default only a
 * published, stable release is accepted; pass allowDraft/allowPrerelease to
 * inspect in-progress releases. Throws before returning anything invalid.
 */
export function validateRelease(
  value: unknown,
  options: { allowDraft?: boolean; allowPrerelease?: boolean } = {},
): Release {
  if (!isRecord(value)) fail("not an object");
  const { id, tag_name, draft, prerelease, html_url } = value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) fail("id must be a positive integer");
  if (typeof tag_name !== "string") fail("missing tag_name");
  const version = releaseVersion(tag_name); // throws on unsafe tags
  if (typeof draft !== "boolean" || typeof prerelease !== "boolean") fail("draft/prerelease must be booleans");
  const stable = !tag_name.includes("-");
  if (prerelease === stable) fail(`tag ${tag_name} disagrees with prerelease=${prerelease}`);
  if (draft && !options.allowDraft) fail(`release ${tag_name} is a draft`);
  if (prerelease && !options.allowPrerelease) fail(`release ${tag_name} is a prerelease`);

  if (typeof html_url !== "string" || !html_url) fail("missing html_url");
  const expectedURL = `${REPO_URL}/releases/tag/${tag_name}`;
  if (draft) {
    // Drafts have no published tag yet; GitHub reports an "untagged-…" URL.
    const draftURL = `${REPO_URL}/releases/tag/untagged-`;
    if (
      html_url !== expectedURL &&
      !(html_url.startsWith(draftURL) && ASSET_NAME.test(html_url.slice(draftURL.length)))
    )
      fail(`unexpected html_url: ${html_url}`);
  } else if (html_url !== expectedURL) {
    fail(`html_url ${html_url} does not match ${expectedURL}`);
  }

  // Published assets live under the tag. A draft's browser_download_url paths
  // carry the same untagged slug as its own html_url — derive the acceptable
  // prefix from that validated html_url, never from the asset URL itself.
  const canonicalDownload = `${REPO_URL}/releases/download/${tag_name}/`;
  const draftDownload =
    draft && html_url.startsWith(`${REPO_URL}/releases/tag/untagged-`)
      ? `${REPO_URL}/releases/download/${html_url.slice(`${REPO_URL}/releases/tag/`.length)}/`
      : null;

  if (!Array.isArray(value.assets)) fail("assets must be an array");
  const assets = value.assets.map(validateAsset);
  const seen = new Set<string>();
  for (const asset of assets) {
    if (seen.has(asset.name)) fail(`duplicate asset name: ${asset.name}`);
    seen.add(asset.name);
    if (
      asset.browser_download_url !== canonicalDownload + asset.name &&
      !(draftDownload && asset.browser_download_url === draftDownload + asset.name)
    )
      fail(`asset ${asset.name}: URL does not belong to this release`);
  }
  for (const name of requiredAssets(version, prerelease)) {
    if (!seen.has(name)) fail(`missing required asset: ${name}`);
  }
  return { id, tag_name, draft, prerelease, html_url, assets };
}

/** The browser_download_url of the named asset; throws if the asset is absent. */
export function assetURL(release: Release, name: string): string {
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`Release ${release.tag_name} has no asset named ${name}`);
  return asset.browser_download_url;
}

/**
 * A canonical fingerprint of everything the release offers: identity, flags
 * and every asset's id/name/size/timestamp/URL. Any asset edit, re-upload or
 * latest-release change produces a different fingerprint.
 */
export function releaseFingerprint(release: Release): string {
  const assets = release.assets
    .map((a) => [a.id, a.name, a.size, a.updated_at, a.browser_download_url])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify({
    id: release.id,
    tag: release.tag_name,
    draft: release.draft,
    prerelease: release.prerelease,
    assets,
  });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function decodeBase64(value: unknown, bytes: number, what: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(`${what}: not base64`);
  const raw = Buffer.from(value, "base64");
  if (raw.length !== bytes || raw.toString("base64") !== value) fail(`${what}: expected ${bytes} bytes`);
  return raw;
}

function parseManifest(raw: string, name: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, "utf8") > MAX_MANIFEST) throw new Error(`${name}: manifest exceeds ${MAX_MANIFEST} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${name}: manifest is not valid JSON`);
  }
  if (!isRecord(value)) throw new Error(`${name}: manifest is not an object`);
  return value;
}

/**
 * Verify a directory of downloaded release assets against the release
 * metadata: sizes and SHA-256 digests from SHA256SUMS for every asset, and
 * every update-<target>.json manifest's version, URL, size and Ed25519
 * signature over the archive's digest. Never executes the downloads.
 */
export async function verifyArtifacts(release: Release, directory: string, publicKey: string): Promise<void> {
  release = validateRelease(release, { allowDraft: true, allowPrerelease: true });
  const version = releaseVersion(release.tag_name);
  const keyBytes = decodeBase64(publicKey, 32, "updater public key");
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes]),
    format: "der",
    type: "spki",
  });

  // Sizes and digests of every downloaded asset.
  const digests = new Map<string, string>();
  for (const asset of release.assets) {
    const path = join(directory, asset.name);
    if (basename(path) !== asset.name) throw new Error(`Unsafe asset name: ${asset.name}`);
    const stat = await lstat(path).catch(() => {
      throw new Error(`Missing downloaded asset: ${asset.name}`);
    });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${asset.name}: not a regular file`);
    if (stat.size !== asset.size)
      throw new Error(`${asset.name}: size ${stat.size} does not match release metadata ${asset.size}`);
    if (/^update-.*\.json$/.test(asset.name) && stat.size > MAX_MANIFEST)
      throw new Error(`${asset.name}: manifest exceeds ${MAX_MANIFEST} bytes`);
    digests.set(asset.name, await sha256File(path));
  }

  // SHA256SUMS: strict format, one entry per line, every asset covered except
  // the sums file itself and the update manifests (mygo excludes them).
  const sums = (await readFile(join(directory, "SHA256SUMS"), "utf8")).split("\n");
  if (sums.at(-1) === "") sums.pop();
  const listed = new Map<string, string>();
  for (const line of sums) {
    const match = SHA256_LINE.exec(line);
    if (!match) throw new Error(`SHA256SUMS: malformed line ${JSON.stringify(line)}`);
    const [, hash = "", name = ""] = match;
    if (listed.has(name)) throw new Error(`SHA256SUMS: duplicate entry for ${name}`);
    listed.set(name, hash);
  }
  // Every supplied entry must match the downloaded bytes — including any
  // manifest digests a producer chose to list.
  for (const [name, expected] of listed) {
    const actual = digests.get(name);
    if (!actual) throw new Error(`SHA256SUMS: unknown file ${name}`);
    if (actual !== expected) throw new Error(`${name}: digest does not match SHA256SUMS`);
  }
  // Coverage: every asset needs a digest except SHA256SUMS itself and the
  // update manifests (mygo excludes them).
  for (const asset of release.assets) {
    if (asset.name === "SHA256SUMS" || /^update-[A-Za-z0-9._-]+\.json$/.test(asset.name)) continue;
    if (!listed.has(asset.name)) throw new Error(`SHA256SUMS: no digest for ${asset.name}`);
  }

  const checkSignedFile = (manifestName: string, fileName: string, url: unknown, size: unknown, signature: unknown) => {
    const fileAsset = release.assets.find((a) => a.name === fileName);
    if (!fileAsset) throw new Error(`${manifestName}: references missing asset ${fileName}`);
    // Manifests always name the future canonical tag URL — even while the
    // release is still a draft and the assets themselves carry an untagged
    // slug. Shipping an untagged URL here would break clients after publish.
    const expectedURL = `${REPO_URL}/releases/download/${release.tag_name}/${fileName}`;
    if (url !== expectedURL)
      throw new Error(`${manifestName}: url ${JSON.stringify(url)} does not match ${expectedURL}`);
    if (size !== fileAsset.size)
      throw new Error(`${manifestName}: size ${JSON.stringify(size)} does not match ${fileAsset.size}`);
    const sig = decodeBase64(signature, 64, `${manifestName}: signature`);
    const digest = digests.get(fileName);
    if (!digest) throw new Error(`${manifestName}: no digest computed for ${fileName}`);
    if (!verify(null, Buffer.from(digest, "hex"), key, sig))
      throw new Error(`Invalid update signature: ${manifestName}`);
  };

  for (const target of releaseTargets(release.prerelease)) {
    const name = `update-${target}.json`;
    const manifest = parseManifest(await readFile(join(directory, name), "utf8"), name);
    if (manifest.version !== version)
      throw new Error(`${name}: version ${JSON.stringify(manifest.version)} does not match ${version}`);
    checkSignedFile(name, `mingle-${version}-${target}.tar.gz`, manifest.url, manifest.size, manifest.signature);

    if (manifest.deltas === undefined) continue;
    if (!Array.isArray(manifest.deltas)) throw new Error(`${name}: deltas is not an array`);
    const froms = new Set<string>();
    for (const delta of manifest.deltas) {
      if (!isRecord(delta)) throw new Error(`${name}: delta is not an object`);
      if (typeof delta.from !== "string") throw new Error(`${name}: invalid delta source version`);
      try {
        releaseVersion(`v${delta.from}`);
      } catch {
        throw new Error(`${name}: invalid delta source version ${JSON.stringify(delta.from)}`);
      }
      if (froms.has(delta.from)) throw new Error(`${name}: duplicate delta from ${delta.from}`);
      froms.add(delta.from);
      checkSignedFile(
        name,
        `mingle-${delta.from}-to-${version}-${target}.delta`,
        delta.url,
        delta.size,
        delta.signature,
      );
    }
  }
}

/** Assemble isolated build artifacts without racing over shared release files. */
export async function assembleArtifacts(tag: string, input: string, output: string): Promise<void> {
  const version = releaseVersion(tag);
  const required = new Set(requiredAssets(version, version.includes("-")));
  const files = new Map<string, { path: string; digest: string }>();
  const sums = new Map<string, string>();
  let fragments = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Not a regular build artifact: ${path}`);
      const name = entry.name;
      if (name === "SHA256SUMS") {
        fragments++;
        const lines = (await readFile(path, "utf8")).split("\n");
        if (lines.at(-1) === "") lines.pop();
        const seen = new Set<string>();
        for (const line of lines) {
          const match = SHA256_LINE.exec(line);
          if (!match) throw new Error(`SHA256SUMS: malformed line ${JSON.stringify(line)}`);
          const [, digest = "", asset = ""] = match;
          if (seen.has(asset)) throw new Error(`SHA256SUMS: duplicate entry for ${asset}`);
          seen.add(asset);
          if (sums.has(asset) && sums.get(asset) !== digest)
            throw new Error(`SHA256SUMS: conflicting digest for ${asset}`);
          sums.set(asset, digest);
        }
        continue;
      }
      if (!ASSET_NAME.test(name) || (!required.has(name) && !/^mingle-.*\.delta$/.test(name)))
        throw new Error(`Unexpected build artifact: ${name}`);
      const digest = await sha256File(path);
      const previous = files.get(name);
      if (previous) {
        if ((name !== "install.sh" && name !== "install.ps1") || previous.digest !== digest)
          throw new Error(`Conflicting build artifact: ${name}`);
      } else {
        files.set(name, { path, digest });
      }
    }
  }
  await visit(input);
  if (fragments === 0) throw new Error("Missing build SHA256SUMS");
  for (const name of required) {
    if (name !== "SHA256SUMS" && !files.has(name)) throw new Error(`Missing build artifact: ${name}`);
  }
  for (const [name, digest] of sums) {
    if (files.get(name)?.digest !== digest) throw new Error(`${name}: digest does not match SHA256SUMS`);
  }
  for (const name of files.keys()) {
    if (!/^update-.*\.json$/.test(name) && !sums.has(name)) throw new Error(`SHA256SUMS: no digest for ${name}`);
  }
  // Validate everything before creating output; never overwrite an earlier assembly.
  await mkdir(output);
  for (const [name, file] of files) await copyFile(file.path, join(output, name));
  await writeFile(
    join(output, "SHA256SUMS"),
    [...sums]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, digest]) => `${digest}  ${name}\n`)
      .join(""),
    "utf8",
  );
}

function readJSON(path: string): Promise<unknown> {
  return readFile(path, "utf8").then(JSON.parse);
}

function latestRelease(): unknown {
  const stdout = execFileSync("gh", ["api", `repos/${REPOSITORY}/releases/latest`], { encoding: "utf8" });
  return JSON.parse(stdout);
}

const usage = `usage:
  node scripts/releases.ts snapshot <output.json>
  node scripts/releases.ts check-latest <snapshot.json>
  node scripts/releases.ts verify <snapshot.json> <assets-dir>
  node scripts/releases.ts assemble <tag> <builds-dir> <assets-dir>`;

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (command === "snapshot" && args.length === 1) {
    const release = validateRelease(latestRelease());
    await writeFile(args[0] as string, `${JSON.stringify(release, null, 2)}\n`, "utf8");
    console.log(`snapshot: latest release ${release.tag_name} (${release.assets.length} assets) → ${args[0]}`);
    return;
  }
  if (command === "check-latest" && args.length === 1) {
    const snapshot = validateRelease(await readJSON(args[0] as string));
    const current = validateRelease(latestRelease());
    if (releaseFingerprint(snapshot) !== releaseFingerprint(current))
      throw new Error(`latest release moved on: snapshot ${snapshot.tag_name} no longer matches ${current.tag_name}`);
    console.log(`check-latest: still ${current.tag_name}`);
    return;
  }
  if (command === "assemble" && args.length === 3) {
    await assembleArtifacts(args[0] as string, args[1] as string, args[2] as string);
    console.log(`assemble: release ${args[0]} artifacts ready`);
    return;
  }
  if (command === "verify" && args.length === 2) {
    const release = validateRelease(await readJSON(args[0] as string), { allowDraft: true, allowPrerelease: true });
    const config = (await import(new URL("../desktop/mygo.config.ts", import.meta.url).href)).default as {
      updates: { publicKey: string };
    };
    await verifyArtifacts(release, args[1] as string, config.updates.publicKey);
    console.log(`verify: release ${release.tag_name} artifacts verified`);
    return;
  }
  console.error(usage);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
