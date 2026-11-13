import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  REPO_URL,
  type Release,
  releaseFingerprint,
  releaseVersion,
  validateRelease,
  verifyArtifacts,
} from "../scripts/releases.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const TAG = "v9.8.7";
const VERSION = "9.8.7";
const UPDATED = "2026-11-13T00:00:00Z";

const STABLE_NAMES = [
  "mingle-9.8.7-arm64.dmg",
  "mingle-9.8.7-amd64.dmg",
  "mingle-setup-9.8.7-amd64.exe",
  "mingle-setup-9.8.7-arm64.exe",
  "mingle_9.8.7_amd64.deb",
  "mingle_9.8.7_arm64.deb",
  "mingle-9.8.7-1.x86_64.rpm",
  "mingle-9.8.7-1.aarch64.rpm",
  "mingle-9.8.7-darwin-arm64.tar.gz",
  "mingle-9.8.7-darwin-amd64.tar.gz",
  "mingle-9.8.7-windows-amd64.tar.gz",
  "mingle-9.8.7-windows-arm64.tar.gz",
  "mingle-9.8.7-linux-amd64.tar.gz",
  "mingle-9.8.7-linux-arm64.tar.gz",
  "update-darwin-arm64.json",
  "update-darwin-amd64.json",
  "update-windows-amd64.json",
  "update-windows-arm64.json",
  "update-linux-amd64.json",
  "update-linux-arm64.json",
  "install.sh",
  "install.ps1",
  "SHA256SUMS",
];
const PRE_NAMES = [
  "mingle-9.8.7-beta.1-arm64.dmg",
  "mingle-9.8.7-beta.1-amd64.dmg",
  "mingle-9.8.7-beta.1-darwin-arm64.tar.gz",
  "mingle-9.8.7-beta.1-darwin-amd64.tar.gz",
  "update-darwin-arm64.json",
  "update-darwin-amd64.json",
  "install.sh",
  "SHA256SUMS",
];

function makeRelease(
  tag: string,
  names: string[],
  flags: { draft?: boolean; prerelease?: boolean; untagged?: string } = {},
) {
  const slug = flags.draft && flags.untagged ? flags.untagged : tag;
  return {
    id: 42,
    tag_name: tag,
    draft: flags.draft ?? false,
    prerelease: flags.prerelease ?? false,
    html_url:
      flags.draft && flags.untagged ? `${REPO_URL}/releases/tag/${flags.untagged}` : `${REPO_URL}/releases/tag/${tag}`,
    assets: names.map((name, i) => ({
      id: i + 1,
      name,
      size: 100 + i,
      state: "uploaded",
      browser_download_url: `${REPO_URL}/releases/download/${slug}/${name}`,
      updated_at: UPDATED,
    })),
  };
}

const stableRelease = () => makeRelease(TAG, STABLE_NAMES);
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture is missing a value");
  return value;
}
const tempDirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mingle-releases-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("releaseVersion", () => {
  it("accepts strict semver tags", () => {
    expect(releaseVersion("v1.2.3")).toBe("1.2.3");
    expect(releaseVersion("v0.1.0-beta.2")).toBe("0.1.0-beta.2");
  });
  it("rejects malformed or hostile tags", () => {
    for (const tag of [
      "1.2.3",
      "v1.2",
      "v1.2.3.4",
      "v01.2.3",
      "v1.2.3-beta.01",
      "v1.2.3/../x",
      "v1.2.3?x=1",
      "v1.2.3<script>",
      "",
    ])
      expect(() => releaseVersion(tag)).toThrow();
  });
});

describe("validateRelease", () => {
  it("accepts a complete stable release", () => {
    const release = validateRelease(stableRelease());
    expect(release.tag_name).toBe(TAG);
    expect(release.assets).toHaveLength(23);
  });
  it("accepts extra assets with safe names", () => {
    const value = stableRelease();
    value.assets.push({
      id: 99,
      name: "mingle-9.8.6-to-9.8.7-darwin-arm64.delta",
      size: 10,
      state: "uploaded",
      browser_download_url: `${REPO_URL}/releases/download/${TAG}/mingle-9.8.6-to-9.8.7-darwin-arm64.delta`,
      updated_at: UPDATED,
    });
    expect(validateRelease(value).assets).toHaveLength(24);
  });
  it("requires every stable installer and target", () => {
    for (const name of ["mingle-setup-9.8.7-arm64.exe", "update-linux-arm64.json", "SHA256SUMS", "install.ps1"]) {
      const value = stableRelease();
      value.assets = value.assets.filter((a) => a.name !== name);
      expect(() => validateRelease(value)).toThrow(new RegExp(name.replace(/\./g, "\\.")));
    }
  });
  it("rejects duplicate, malformed and cross-release assets", () => {
    const dup = stableRelease();
    dup.assets.push({ ...must(dup.assets[0]), id: 99 });
    expect(() => validateRelease(dup)).toThrow(/duplicate/);

    const zero = stableRelease();
    must(zero.assets[0]).size = 0;
    expect(() => validateRelease(zero)).toThrow(/size/);

    const badState = stableRelease();
    must(badState.assets[0]).state = "starter";
    expect(() => validateRelease(badState)).toThrow(/state/);

    const evilName = stableRelease();
    must(evilName.assets[0]).name = "../evil";
    expect(() => validateRelease(evilName)).toThrow();

    const cross = stableRelease();
    must(cross.assets[0]).browser_download_url = `${REPO_URL}/releases/download/v9.9.9/${must(cross.assets[0]).name}`;
    expect(() => validateRelease(cross)).toThrow(/URL/);

    const foreign = stableRelease();
    must(foreign.assets[0]).browser_download_url = "https://evil.example.com/x";
    expect(() => validateRelease(foreign)).toThrow(/URL/);
  });
  it("rejects draft and prerelease by default", () => {
    expect(() => validateRelease(makeRelease(TAG, STABLE_NAMES, { draft: true }))).toThrow(/draft/);
    expect(() => validateRelease(makeRelease("v9.8.7-beta.1", PRE_NAMES, { prerelease: true }))).toThrow(/prerelease/);
  });
  it("accepts a prerelease with only macOS assets when allowed", () => {
    const release = validateRelease(makeRelease("v9.8.7-beta.1", PRE_NAMES, { prerelease: true }), {
      allowPrerelease: true,
    });
    expect(release.assets).toHaveLength(8);
  });
  it("rejects tag and prerelease flag disagreement", () => {
    expect(() => validateRelease(makeRelease(TAG, STABLE_NAMES, { prerelease: true }))).toThrow();
    expect(() => validateRelease(makeRelease("v9.8.7-beta.1", PRE_NAMES), { allowPrerelease: true })).toThrow();
  });
  it("accepts untagged html_url only for allowed drafts", () => {
    const draft = makeRelease(TAG, STABLE_NAMES, { draft: true });
    draft.html_url = `${REPO_URL}/releases/tag/untagged-abc123`;
    expect(validateRelease(draft, { allowDraft: true }).draft).toBe(true);
    draft.html_url = `${REPO_URL}/releases/tag/other-tag`;
    expect(() => validateRelease(draft, { allowDraft: true })).toThrow(/html_url/);
  });
  it("accepts draft assets under the draft's own untagged slug", () => {
    const draft = makeRelease(TAG, STABLE_NAMES, { draft: true, untagged: "untagged-b2f6361d7cc95e7593e4" });
    expect(validateRelease(draft, { allowDraft: true }).tag_name).toBe(TAG);
  });
  it("rejects draft assets under a different slug, and untagged URLs when published", () => {
    const wrongSlug = makeRelease(TAG, STABLE_NAMES, { draft: true, untagged: "untagged-b2f6361d7cc95e7593e4" });
    wrongSlug.assets = wrongSlug.assets.map((a) => ({
      ...a,
      browser_download_url: a.browser_download_url.replace("untagged-b2f6361d7cc95e7593e4", "untagged-deadbeef"),
    }));
    expect(() => validateRelease(wrongSlug, { allowDraft: true })).toThrow(/does not belong/);

    const published = makeRelease(TAG, STABLE_NAMES);
    published.assets = published.assets.map((a) => ({
      ...a,
      browser_download_url: `${REPO_URL}/releases/download/untagged-b2f6361d7cc95e7593e4/${a.name}`,
    }));
    expect(() => validateRelease(published)).toThrow(/does not belong/);
  });
  it('rejects "." and ".." asset names', () => {
    for (const name of [".", ".."]) {
      const value = stableRelease();
      must(value.assets[0]).name = name;
      expect(() => validateRelease(value)).toThrow(/unsafe/);
    }
  });
  it("rejects non-JSON shapes", () => {
    for (const value of [null, 42, "x", [], { id: 1 }]) expect(() => validateRelease(value)).toThrow();
  });
});

describe("releaseFingerprint", () => {
  it("is insensitive to asset order", () => {
    const a = validateRelease(stableRelease());
    const reversed = stableRelease();
    reversed.assets.reverse();
    const b = validateRelease(reversed);
    expect(releaseFingerprint(a)).toBe(releaseFingerprint(b));
  });
  it("changes on identity and asset mutations", () => {
    const base = validateRelease(stableRelease());
    const fingerprint = releaseFingerprint(base);
    const variants = [
      { ...base, id: 43 },
      { ...base, tag_name: "v9.8.8" },
      { ...base, assets: base.assets.map((a, i) => (i === 0 ? { ...a, size: a.size + 1 } : a)) },
      { ...base, assets: base.assets.map((a, i) => (i === 0 ? { ...a, updated_at: "2026-11-14T00:00:00Z" } : a)) },
      { ...base, assets: base.assets.slice(1) },
    ];
    for (const variant of variants) expect(releaseFingerprint(variant)).not.toBe(fingerprint);
  });
});

describe("verifyArtifacts", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyB64 = Buffer.from(publicKey.export({ format: "der", type: "spki" }))
    .subarray(-32)
    .toString("base64");
  const signDigest = (hex: string) => sign(null, Buffer.from(hex, "hex"), privateKey).toString("base64");
  const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
  const TARGETS = ["darwin-arm64", "darwin-amd64", "windows-amd64", "windows-arm64", "linux-amd64", "linux-arm64"];
  const UNTAGGED = "untagged-b2f6361d7cc95e7593e4";

  interface Fixture {
    release: Release;
    dir: string;
    editManifest: (name: string, edit: (doc: Record<string, unknown>) => void) => void;
    /** Resync asset sizes in the metadata to the files currently on disk. */
    refresh: () => void;
  }

  /**
   * Write a complete signed release fixture into a fresh dir. Manifests always
   * name the future canonical tag URL; with `draft` the metadata's html_url
   * and browser URLs carry an untagged slug, as GitHub actually serves drafts.
   */
  function fixture(options: { delta?: boolean; draft?: boolean } = {}): Fixture {
    const dir = tempDir();
    const names = [...STABLE_NAMES];
    const deltaName = `mingle-9.8.6-to-${VERSION}-darwin-arm64.delta`;
    if (options.delta) names.push(deltaName);
    const contents = new Map(names.map((name) => [name, `payload of ${name}`]));
    for (const [name, content] of contents) writeFileSync(join(dir, name), content);

    const raw = options.draft ? makeRelease(TAG, names, { draft: true, untagged: UNTAGGED }) : makeRelease(TAG, names);

    const digestOf = (name: string) => sha256(readFileSync(join(dir, name)));
    const manifest = (target: string) => {
      const archive = `mingle-${VERSION}-${target}.tar.gz`;
      const doc: Record<string, unknown> = {
        version: VERSION,
        url: `${REPO_URL}/releases/download/${TAG}/${archive}`,
        size: must(contents.get(archive)).length,
        signature: signDigest(digestOf(archive)),
      };
      if (options.delta && target === "darwin-arm64") {
        doc.deltas = [
          {
            from: "9.8.6",
            url: `${REPO_URL}/releases/download/${TAG}/${deltaName}`,
            size: must(contents.get(deltaName)).length,
            signature: signDigest(digestOf(deltaName)),
          },
        ];
        doc.previous = { url: "https://example.invalid/old.json" };
      }
      return doc;
    };
    for (const target of TARGETS) writeFileSync(join(dir, `update-${target}.json`), JSON.stringify(manifest(target)));
    const sums = names
      .filter((n) => !/^update-.*\.json$/.test(n) && n !== "SHA256SUMS")
      .map((n) => `${digestOf(n)}  ${n}`)
      .join("\n");
    writeFileSync(join(dir, "SHA256SUMS"), `${sums}\n`);

    const release = validateRelease(raw, { allowDraft: true, allowPrerelease: true });
    const refresh = () => {
      for (const asset of release.assets) {
        try {
          const stat = statSync(join(dir, asset.name));
          if (stat.isFile()) asset.size = stat.size;
        } catch {
          // missing files stay missing on purpose
        }
      }
    };
    refresh();
    const editManifest = (name: string, edit: (doc: Record<string, unknown>) => void) => {
      const doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      edit(doc);
      writeFileSync(join(dir, name), JSON.stringify(doc));
    };
    return { release, dir, editManifest, refresh };
  }

  /** Mutate, resync metadata sizes (size drift is its own test), expect `pattern`. */
  const rejects =
    (
      pattern: RegExp,
      mutate: (f: Fixture) => void,
      options: { delta?: boolean; draft?: boolean; keepSizes?: boolean } = {},
    ) =>
    async () => {
      const f = fixture(options);
      mutate(f);
      if (!options.keepSizes) f.refresh();
      await expect(verifyArtifacts(f.release, f.dir, publicKeyB64)).rejects.toThrow(pattern);
    };

  it("verifies a correctly signed release, with a delta", async () => {
    const f = fixture({ delta: true });
    await expect(verifyArtifacts(f.release, f.dir, publicKeyB64)).resolves.toBeUndefined();
  });
  it("verifies a draft release with untagged URLs and canonical manifests", async () => {
    const f = fixture({ delta: true, draft: true });
    await expect(verifyArtifacts(f.release, f.dir, publicKeyB64)).resolves.toBeUndefined();
  });

  it(
    "rejects corrupted bytes of the same length",
    rejects(/digest does not match/, (f) => {
      const name = "mingle-9.8.7-darwin-arm64.tar.gz";
      writeFileSync(join(f.dir, name), "x".repeat(`payload of ${name}`.length));
    }),
  );
  it("rejects a wrong signing key", async () => {
    const f = fixture();
    const other = generateKeyPairSync("ed25519").publicKey;
    const otherB64 = Buffer.from(other.export({ format: "der", type: "spki" }))
      .subarray(-32)
      .toString("base64");
    await expect(verifyArtifacts(f.release, f.dir, otherB64)).rejects.toThrow(/signature/);
  });
  it(
    "rejects a manifest version mismatch",
    rejects(/version/, (f) => f.editManifest("update-linux-amd64.json", (doc) => (doc.version = "9.8.8"))),
  );
  it(
    "rejects a manifest URL mismatch",
    rejects(/url/, (f) =>
      f.editManifest("update-darwin-amd64.json", (doc) => {
        doc.url = `${REPO_URL}/releases/download/${TAG}/other.tar.gz`;
      }),
    ),
  );
  it(
    "rejects an untagged manifest URL even while the draft itself uses that slug",
    rejects(/url/, (f) =>
      f.editManifest("update-darwin-arm64.json", (doc) => {
        doc.url = String(doc.url).replace(TAG, UNTAGGED);
      }),
    ),
  );
  it(
    "rejects a manifest size mismatch",
    rejects(/size/, (f) => f.editManifest("update-darwin-amd64.json", (doc) => (doc.size = (doc.size as number) + 1))),
  );
  it(
    "rejects an oversized manifest",
    rejects(/manifest exceeds/, (f) =>
      writeFileSync(join(f.dir, "update-linux-amd64.json"), " ".repeat(1024 * 1024 + 1)),
    ),
  );
  it(
    "rejects a metadata size that disagrees with the file",
    rejects(
      /size .* does not match release metadata/,
      (f) => writeFileSync(join(f.dir, "mingle-9.8.7-darwin-arm64.tar.gz"), "short"),
      { keepSizes: true },
    ),
  );
  it(
    "rejects a missing archive",
    rejects(/Missing downloaded asset/, (f) => rmSync(join(f.dir, "mingle-9.8.7-windows-amd64.tar.gz"))),
  );
  it(
    "rejects a checksum entry removed from SHA256SUMS",
    rejects(/no digest/, (f) => {
      const path = join(f.dir, "SHA256SUMS");
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => !l.endsWith("install.sh"));
      writeFileSync(path, lines.join("\n"));
    }),
  );
  it(
    "rejects a tampered checksum",
    rejects(/digest does not match/, (f) => {
      const path = join(f.dir, "SHA256SUMS");
      const text = readFileSync(path, "utf8");
      const first = text[0] === "0" ? "1" : "0";
      writeFileSync(path, first + text.slice(1));
    }),
  );
  it(
    "rejects a duplicate checksum entry",
    rejects(/duplicate/, (f) => {
      const path = join(f.dir, "SHA256SUMS");
      const text = readFileSync(path, "utf8");
      const line = must(text.split("\n")[0]);
      writeFileSync(path, `${line}\n${text}`);
    }),
  );
  it(
    "rejects a checksum entry for a file the release does not have",
    rejects(/unknown file/, (f) => {
      const path = join(f.dir, "SHA256SUMS");
      writeFileSync(path, `${readFileSync(path, "utf8")}${sha256("x")}  mingle-9.8.7-extra.txt\n`);
    }),
  );
  it(
    "rejects a path-escape checksum entry",
    rejects(/malformed/, (f) => {
      const path = join(f.dir, "SHA256SUMS");
      writeFileSync(path, `${readFileSync(path, "utf8")}${sha256("x")}  ../evil\n`);
    }),
  );
  it(
    "rejects a supplied manifest digest that does not match",
    rejects(/digest does not match/, (f) => {
      const path = join(f.dir, "SHA256SUMS");
      writeFileSync(path, `${readFileSync(path, "utf8")}${"0".repeat(64)}  update-darwin-arm64.json\n`);
    }),
  );
  it(
    "rejects a forged signature",
    rejects(/signature/, (f) =>
      f.editManifest("update-darwin-arm64.json", (doc) => (doc.signature = signDigest(sha256("forged")))),
    ),
  );
  it(
    "rejects a tampered delta signature",
    rejects(
      /signature/,
      (f) =>
        f.editManifest("update-darwin-arm64.json", (doc) => {
          must((doc.deltas as Record<string, unknown>[])[0]).signature = signDigest(sha256("wrong"));
        }),
      { delta: true },
    ),
  );
  it(
    "rejects a missing delta file",
    rejects(/Missing downloaded asset/, (f) => rmSync(join(f.dir, "mingle-9.8.6-to-9.8.7-darwin-arm64.delta")), {
      delta: true,
    }),
  );
});

describe("site build", () => {
  const BUILD = join(ROOT, "site/scripts/build.mjs");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string };

  async function build(snapshot: unknown, out: string) {
    const file = join(tempDir(), "release.json");
    writeFileSync(file, JSON.stringify(snapshot));
    await run("node", [BUILD, "--release", file, "--out", out]);
  }

  it("renders both languages from the snapshot, not package.json", async () => {
    const out = join(tempDir(), "dist");
    await build(stableRelease(), out);
    const en = readFileSync(join(out, "index.html"), "utf8");
    const zh = readFileSync(join(out, "zh", "index.html"), "utf8");
    const llms = readFileSync(join(out, "llms.txt"), "utf8");
    const dl = `${REPO_URL}/releases/download/${TAG}`;
    for (const name of STABLE_NAMES.slice(0, 8)) {
      expect(en).toContain(`${dl}/${name}`);
      expect(zh).toContain(`${dl}/${name}`);
    }
    expect(en).toContain(`data-mac="${dl}/mingle-${VERSION}-arm64.dmg"`);
    expect(en).toContain(`data-windows="${dl}/mingle-setup-${VERSION}-amd64.exe"`);
    expect(en).toContain(`href="${REPO_URL}/releases/tag/${TAG}"`);
    expect(en).toContain("v9.8.7");
    expect(zh).toContain("发布说明");
    expect(en).not.toContain("aren't signed");
    expect(zh).not.toContain("暂未签名");
    expect(en).not.toContain(`mingle-${pkg.version}-`);
    expect(llms).toContain(`${REPO_URL}/releases/tag/${TAG}`);
    expect(llms).toContain("v9.8.7");
    expect(llms).toContain("release notes");
    expect(en).toContain("/releases/latest/download/install.sh");
  });

  it("fails without --release instead of using package.json", async () => {
    await expect(run("node", [BUILD, "--out", join(tempDir(), "x")])).rejects.toThrow();
  });

  it("rejects an invalid or prerelease snapshot and preserves existing output", async () => {
    const out = join(tempDir(), "dist");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "sentinel.txt"), "keep me");
    const sentinel = () => expect(readFileSync(join(out, "sentinel.txt"), "utf8")).toBe("keep me");

    const invalid = stableRelease();
    invalid.assets = invalid.assets.filter((a) => a.name !== "SHA256SUMS");
    await expect(build(invalid, out)).rejects.toThrow();
    sentinel();

    const pre = makeRelease("v9.8.7-beta.1", PRE_NAMES, { prerelease: true });
    await expect(build(pre, out)).rejects.toThrow();
    sentinel();
  });
});

describe("package-smoke tar", () => {
  it.skipIf(process.platform === "win32")("smokes a tar.gz package and checks the expected version", async () => {
    const dir = tempDir();
    const pkg = join(dir, "pkg");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    mkdirSync(join(pkg, "dist", "cli"), { recursive: true });
    symlinkSync(process.execPath, join(pkg, "bin", "node"));
    writeFileSync(
      join(pkg, "dist", "cli", "main.js"),
      `const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("9.8.7"); process.exit(0); }
if (args[0] === "start") {
  const port = Number(args[args.indexOf("--port") + 1]);
  const { createServer } = await import("node:http");
  createServer((req, res) => {
    if (req.url === "/v1/health") { res.writeHead(200); res.end("ok"); }
    else { res.writeHead(404); res.end(); }
  }).listen(port, "127.0.0.1");
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
}
`,
    );
    const artifact = join(dir, "mingle-9.8.7-linux-amd64.tar.gz");
    await run("tar", ["-czf", artifact, "-C", pkg, "."]);

    const smoke = join(ROOT, "scripts/package-smoke.mjs");
    await expect(
      run("node", [smoke, artifact], { env: { ...process.env, MINGLE_EXPECTED_VERSION: "9.8.7" } }),
    ).resolves.toBeTruthy();
    await expect(
      run("node", [smoke, artifact], { env: { ...process.env, MINGLE_EXPECTED_VERSION: "9.8.6" } }),
    ).rejects.toThrow();
  });
});
