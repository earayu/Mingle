import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  assembleArtifacts,
  REPO_URL,
  type Release,
  releaseFingerprint,
  releaseVersion,
  requiredAssets,
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

  it("verifies the same fixture after assembleArtifacts merges isolated legs", async () => {
    const f = fixture({ delta: true, draft: true });
    const input = tempDir();
    const legs = [join(input, "leg-a"), join(input, "leg-b")];
    for (const leg of legs) mkdirSync(join(leg, "target"), { recursive: true });
    // Split the built assets between the legs like parallel build jobs would;
    // install.sh is the shared script every leg produces identically.
    const assets = readdirSync(f.dir).filter((n) => n !== "SHA256SUMS");
    for (const [i, name] of assets.entries()) {
      if (name === "install.sh") continue;
      cpSync(join(f.dir, name), join(must(legs[i % 2]), "target", name));
    }
    for (const leg of legs) {
      cpSync(join(f.dir, "install.sh"), join(leg, "target", "install.sh"));
      const sums = readdirSync(join(leg, "target"))
        .filter((n) => !/^update-.*\.json$/.test(n))
        .map((n) => `${sha256(readFileSync(join(leg, "target", n)))}  ${n}\n`)
        .join("");
      writeFileSync(join(leg, "SHA256SUMS"), sums);
    }
    const output = join(tempDir(), "assembled");
    await assembleArtifacts(TAG, input, output);

    // The merged SHA256SUMS is sorted and rewritten, so refresh the metadata
    // sizes against the assembled files before verifying.
    const release: Release = {
      ...f.release,
      assets: f.release.assets.map((a) => ({ ...a, size: statSync(join(output, a.name)).size })),
    };
    await expect(verifyArtifacts(release, output, publicKeyB64)).resolves.toBeUndefined();
  });
});

describe("assembleArtifacts", () => {
  const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

  /**
   * A fake two-leg build: every required asset lands in exactly one leg's
   * target directory, each leg gets an identical shared install.sh and its
   * own SHA256SUMS fragment covering its local non-manifest files.
   */
  function builds(tag = TAG) {
    const input = tempDir();
    const output = join(tempDir(), "assembled");
    const names = requiredAssets(tag.slice(1), tag.includes("-")).filter((n) => n !== "SHA256SUMS");
    const groups = [
      join(input, "mingle-macOS-arm64", "darwin-arm64"),
      join(input, "mingle-macOS-amd64", "darwin-amd64"),
    ];
    for (const group of groups) mkdirSync(group, { recursive: true });
    for (const [i, name] of names.entries()) writeFileSync(join(must(groups[i % 2]), name), `payload of ${name}`);
    for (const group of groups) writeFileSync(join(group, "install.sh"), "shared installer");
    for (const group of groups)
      writeFileSync(
        join(group, "..", "SHA256SUMS"),
        readdirSync(group)
          .filter((n) => !n.startsWith("update-"))
          .map((n) => `${sha256(readFileSync(join(group, n)))}  ${n}\n`)
          .join(""),
      );
    return { input, output, groups, names };
  }

  /** The leg directory that currently holds `name`. */
  const holder = (groups: string[], name: string) => must(groups.find((g) => existsSync(join(g, name))));

  // The actual shell of the workflow's upload step, run locally with a stubbed
  // `gh` function so the test exercises the shipped script — including the
  // real assemble CLI — without any external publication.
  const uploadScript = must(
    /- name: Assemble and upload the draft release\n[\s\S]*?run: \|\n([\s\S]*?)\n {2}# Downloads/.exec(
      readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
    )?.[1],
  )
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const ghStub = `gh() {
  node -e 'require("node:fs").appendFileSync(process.env.GH_CALLS, JSON.stringify(process.argv.slice(1)) + "\\n")' "$@"
  case "$1 $2" in
    "release view")
      [ "$GH_TEST_VIEW" != error ] || return 1
      printf '%s\\n' "$GH_TEST_VIEW"
      ;;
    "release upload")
      [ "$GH_TEST_FAIL_UPLOAD" != true ] || return 1
      ;;
    *) return 1 ;;
  esac
}
`;

  async function upload(view: "true" | "false" | "error", failUpload = false) {
    const { input } = builds();
    const runtime = tempDir();
    cpSync(input, join(runtime, "release-builds"), { recursive: true });
    const callsPath = join(runtime, "gh-calls");
    const script = join(runtime, "upload.sh");
    writeFileSync(script, ghStub + uploadScript);
    const result = await run("bash", ["-e", "-o", "pipefail", script], {
      cwd: ROOT,
      env: {
        ...process.env,
        TAG,
        RUNNER_TEMP: runtime,
        GH_CALLS: callsPath,
        GH_TEST_VIEW: view,
        GH_TEST_FAIL_UPLOAD: String(failUpload),
      },
    }).then(
      () => true,
      () => false,
    );
    const calls = existsSync(callsPath)
      ? readFileSync(callsPath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
    return { result, calls };
  }

  it.skipIf(process.platform === "win32")("uploads payloads then manifests, only to a draft release", async () => {
    const { result, calls } = await upload("true");
    expect(result).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual(["release", "view", TAG, "--json", "isDraft", "--jq", ".isDraft"]);
    expect(calls[1]?.slice(0, 4)).toEqual(["release", "upload", TAG, "--clobber"]);
    expect(calls[2]?.slice(0, 4)).toEqual(["release", "upload", TAG, "--clobber"]);
    const isManifest = (n: string) => /^update-.*\.json$/.test(n);
    expect(
      must(calls[1])
        .slice(4)
        .map((p) => basename(p))
        .sort(),
    ).toEqual(
      requiredAssets(VERSION, false)
        .filter((n) => !isManifest(n))
        .sort(),
    );
    expect(
      must(calls[2])
        .slice(4)
        .map((p) => basename(p))
        .sort(),
    ).toEqual(requiredAssets(VERSION, false).filter(isManifest).sort());
  });

  it.skipIf(process.platform === "win32").each(["false", "error"])(
    "refuses to upload when the release is published or uninspectable (view=%s)",
    async (view) => {
      const { result, calls } = await upload(view as "false" | "error");
      expect(result).toBe(false);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[1]).toBe("view");
    },
  );

  it.skipIf(process.platform === "win32")(
    "stops before uploading manifests when the payload upload fails",
    async () => {
      const { result, calls } = await upload("true", true);
      expect(result).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls[1]?.[1]).toBe("upload");
    },
  );

  it.each([TAG, "v9.8.7-beta.1"])("assembles %s artifacts into one verified set", async (tag) => {
    const { input, output, names } = builds(tag);
    await assembleArtifacts(tag, input, output);

    const expected = requiredAssets(tag.slice(1), tag.includes("-"));
    expect(readdirSync(output).sort()).toEqual([...expected].sort());
    expect(readFileSync(join(output, "install.sh"), "utf8")).toBe("shared installer");
    for (const name of names) {
      expect(readFileSync(join(output, name), "utf8")).toBe(
        name === "install.sh" ? "shared installer" : `payload of ${name}`,
      );
    }

    const sums = readFileSync(join(output, "SHA256SUMS"), "utf8");
    expect(sums.split("\n").filter((l) => l.endsWith("  install.sh"))).toHaveLength(1);
    for (const name of expected) {
      if (name === "SHA256SUMS" || /^update-.*\.json$/.test(name)) continue;
      expect(sums).toContain(`${sha256(readFileSync(join(output, name)))}  ${name}`);
    }
  });

  it("rejects shared scripts whose bytes differ, leaving no output", async () => {
    const { input, output, groups } = builds();
    writeFileSync(join(must(groups[1]), "install.sh"), "different installer");
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow(
      /Conflicting build artifact|conflicting digest|digest does not match/,
    );
    expect(existsSync(output)).toBe(false);
  });

  it("rejects a unique asset duplicated across legs", async () => {
    const { input, output, groups } = builds();
    const manifest = "update-darwin-arm64.json";
    cpSync(
      join(holder(groups, manifest), manifest),
      join(must(groups.find((g) => !existsSync(join(g, manifest)))), manifest),
    );
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow(/Conflicting build artifact/);
  });

  it("rejects a missing required asset", async () => {
    const { input, output, groups } = builds();
    const name = "mingle-9.8.7-arm64.dmg";
    rmSync(join(holder(groups, name), name));
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow(/Missing build artifact/);
  });

  it("rejects payload bytes that drift from the leg's SHA256SUMS", async () => {
    const { input, output, groups } = builds();
    const name = "mingle-9.8.7-arm64.dmg";
    writeFileSync(join(holder(groups, name), name), "tampered payload");
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow(/digest does not match/);
  });

  it("rejects a checksum line with an unsafe asset name", async () => {
    const { input, output } = builds();
    const fragment = join(input, "mingle-macOS-arm64", "SHA256SUMS");
    writeFileSync(fragment, `${readFileSync(fragment, "utf8")}${"0".repeat(64)}  ../escape\n`);
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow(/malformed line/);
  });

  it("rejects a leg without checksums and a cross-leg digest conflict", async () => {
    const { input, output, groups } = builds();
    const fragment = join(input, "mingle-macOS-amd64", "SHA256SUMS");
    writeFileSync(fragment, "");
    expect(readdirSync(must(groups[1])).some((n) => n !== "install.sh" && !n.startsWith("update-"))).toBe(true);
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow(/no digest/);

    const conflict = builds();
    const first = join(conflict.input, "mingle-macOS-arm64", "SHA256SUMS");
    writeFileSync(
      first,
      readFileSync(first, "utf8").replace(/^[a-f0-9]{64}( {2}install\.sh)$/m, `${"0".repeat(64)}$1`),
    );
    await expect(assembleArtifacts(TAG, conflict.input, conflict.output)).rejects.toThrow(/conflicting digest/);
  });

  it("never overwrites an existing output directory", async () => {
    const { input, output } = builds();
    mkdirSync(output);
    writeFileSync(join(output, "sentinel.txt"), "keep me");
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow();
    expect(readFileSync(join(output, "sentinel.txt"), "utf8")).toBe("keep me");
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked artifact", async () => {
    const { input, output, groups } = builds();
    symlinkSync(join(holder(groups, "install.sh"), "install.sh"), join(must(groups[0]), "mingle-9.8.7-evil.delta"));
    await expect(assembleArtifacts(TAG, input, output)).rejects.toThrow(/Not a regular/);
  });

  it("carries delta files through to the assembled output", async () => {
    const { input, output, groups } = builds();
    const delta = "mingle-9.8.6-to-9.8.7-darwin-arm64.delta";
    const group = must(groups[0]);
    writeFileSync(join(group, delta), `payload of ${delta}`);
    const fragment = join(group, "..", "SHA256SUMS");
    writeFileSync(fragment, `${readFileSync(fragment, "utf8")}${sha256(`payload of ${delta}`)}  ${delta}\n`);
    await assembleArtifacts(TAG, input, output);
    expect(readFileSync(join(output, delta), "utf8")).toBe(`payload of ${delta}`);
  });
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

describe.skipIf(process.platform === "win32")("release workflow plan", () => {
  const YAML = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  // The actual shell of the plan step, lifted out of the workflow so the test
  // runs the shipped script rather than a copied implementation.
  const block = must(/- id: plan\n[\s\S]*?run: \|\n([\s\S]*?)\n {6}- name: Create the draft release/.exec(YAML)?.[1])
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");

  async function plan(version: string, ref: string, refName: string) {
    const dir = tempDir();
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ version })}\n`);
    writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## ${version}\n\nNotes.\n`);
    const script = join(dir, "plan.sh");
    writeFileSync(script, block);
    const githubOutput = join(dir, "github-output");
    await run("bash", [script], {
      cwd: dir,
      env: { ...process.env, GITHUB_REF: ref, GITHUB_REF_NAME: refName, GITHUB_OUTPUT: githubOutput },
    });
    const lines = readFileSync(githubOutput, "utf8").split("\n");
    const value = (key: string) => must(lines.find((l) => l.startsWith(`${key}=`))).slice(key.length + 1);
    const rows = (key: string) =>
      (JSON.parse(value(key)) as { include: Record<string, string>[] }).include.map((r) => r);
    return {
      tag: value("tag"),
      platforms: rows("matrix").map((r) => r.platform),
      smoke: rows("smoke_matrix").map((r) => r.artifact),
    };
  }

  const ALL_PLATFORMS = ["darwin/arm64", "darwin/amd64", "windows/amd64,windows/arm64", "linux/amd64,linux/arm64"];

  it("splits macOS into two legs and keeps every platform for a stable tag", async () => {
    const out = await plan("9.8.7", "refs/tags/v9.8.7", "v9.8.7");
    expect(out.tag).toBe("v9.8.7");
    expect(out.platforms).toEqual(ALL_PLATFORMS);
    expect(out.smoke).toContain("mingle-macOS-arm64");
  });

  it("builds only the two macOS legs for a tagged prerelease", async () => {
    const out = await plan("9.8.7-beta.1", "refs/tags/v9.8.7-beta.1", "v9.8.7-beta.1");
    expect(out.platforms).toEqual(["darwin/arm64", "darwin/amd64"]);
    expect(out.smoke).toEqual(["mingle-macOS-arm64"]);
  });

  it("builds every platform for manual runs, stable or beta", async () => {
    for (const version of ["9.8.7", "9.8.7-beta.1"]) {
      const out = await plan(version, "refs/heads/main", "main");
      expect(out.tag).toBe("");
      expect(out.platforms).toEqual(ALL_PLATFORMS);
    }
  });

  it("rejects a tag that does not match package.json", async () => {
    await expect(plan("9.8.7", "refs/tags/v9.8.8", "v9.8.8")).rejects.toThrow();
  });

  it("has no serialized matrix or in-build upload left", () => {
    expect(YAML).not.toContain("max-parallel");
    expect(YAML).not.toContain("upload=-upload");
    expect(YAML).not.toContain(" $upload");
    expect(YAML).toContain("mingle-macOS-arm64");
  });
});
