// The desktop app's configuration for the mygo CLI (https://github.com/egoist/mygo).
// Plain object, no import: the CLI evaluates this file with Node.js type stripping.
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default {
  name: "Mingle",
  slug: "mingle",
  identifier: "io.github.earayu.mingle",
  // The app and the npm package release together, from one version.
  version,
  copyright: "© 2026 Mingle contributors",
  license: "MIT",
  out: "build",
  updates: {
    publicKey: "sPkcU9YfvgSNIpGsaSHyvJgx+Tf/jCRJpjOdlzHIOGM=",
    github: "earayu/Mingle",
    // Release notes for the update window: the version's section of the root changelog.
    changelog: "../CHANGELOG.md",
  },
  linux: {
    comment: "Agent companions in the chat apps you already use",
    categories: ["Network", "Chat"],
    // The tray icon needs an AppIndicator implementation.
    depends: ["libayatana-appindicator3-1"],
    formats: ["deb", "rpm"],
  },
  macos: {
    minimumSystemVersion: "13.0",
    // A menu bar app: no Dock icon until the window shows.
    infoPlist: { LSUIElement: true, CFBundleLocalizations: ["en", "zh-CN"] },
    // Ad hoc unless a Developer ID is given (CI sets these, see .github/workflows/desktop.yml).
    signingIdentity: process.env.MACOS_SIGNING_IDENTITY ?? "-",
    ...(process.env.NOTARY_KEYCHAIN
      ? { notarize: { keychainProfile: "notary", keychain: process.env.NOTARY_KEYCHAIN } }
      : {}),
  },
};
