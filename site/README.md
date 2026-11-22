# mingle.build

The website: static pages in English and Chinese (`/` and `/zh/`, plus per-app integration guides at `/<app>/` and `/zh/<app>/`), `llms.txt` and `llms-full.txt` for AI agents, and real screenshots of the console. No framework; one generator script.

```text
site/scripts/copy.mjs          every word on the homepage, en and zh; keep the two in step
site/scripts/integrations.mjs  bilingual integration landing pages for all 10 platforms
site/scripts/topics.mjs        bilingual harness guides (claude-code, codex, opencode, kimi-code), /security/ and /compare/
site/scripts/harnesses.mjs     the harnesses on the Brains row, in the console's order
site/scripts/demo.mjs          the homepage demo's scenes (one agent in Feishu, WeChat, Telegram, Discord), en and zh; they play by themselves
site/scripts/assets.mjs        converts site/img/*.png to WebP twins and renders 1200x630 Open Graph cards into site/img/og/
site/scripts/build.mjs         renders site/dist from copy.mjs, integrations.mjs, topics.mjs and a release snapshot
site/scripts/screenshots.mjs   seeds a throwaway Mingle and shoots the console into site/img, light and dark; refreshes site/icons from OAR
site/scripts/review.mjs        screenshots the built site section by section, desktop and phone, into .site-review/page/
site/scripts/demo-review.mjs   plays every demo scene in headless Chrome, tapping Send, into .site-review/demo/
site/styles.css, site/main.js  the look (DESIGN.md's tokens) and the few behaviors (OS download, copy, motion, the phones, the demo player)
site/wrangler.jsonc            deploys site/dist as a static-assets Worker on mingle.build and www.mingle.build
```

The download links never come from `package.json`. The published "latest"
GitHub release is the single source of truth: `scripts/releases.ts snapshot`
freezes its full metadata to JSON, and the renderer validates that snapshot and
links to its exact asset URLs. A stored snapshot renders identically offline;
there is no fallback — an invalid or missing snapshot fails the build. The
terminal install commands (`install.sh`, `install.ps1`) deliberately follow
`/releases/latest/` because the scripts resolve the current release
internally. Signing details are not promised on the page: each version's
release notes carry them.

## Update

```sh
pnpm build && node site/scripts/screenshots.mjs   # only when the console changed; needs Google Chrome
mkdir -p .site-review
node scripts/releases.ts snapshot .site-review/latest-release.json   # freeze the published release
node site/scripts/build.mjs --release .site-review/latest-release.json
node site/scripts/review.mjs                       # look at every image in .site-review/page/
node site/scripts/demo-review.mjs [--motion]      # every demo scene must finish; look at .site-review/demo/
```

## Deploy

`.github/workflows/website.yml` deploys automatically: on every published or
edited release, on pushes to main that touch `site/` or the release tooling,
and on manual `gh workflow run website.yml --ref main`. It snapshots the latest
release, rebuilds the site, then re-checks the snapshot is still latest
immediately before deploying. Setup needs two GitHub Actions secrets for the
existing `mingle-build` Worker — `CLOUDFLARE_API_TOKEN` (a token that can edit
Workers on the `mingle.build` zone) and `CLOUDFLARE_ACCOUNT_ID`; the job fails
with a clear error if they are missing. The pre-deploy check aborts the run if
the release changed between snapshot and deploy; a release that lands after the
check but before the upload finishes cannot be atomically prevented — a manual
rerun repairs it.

Preview the deploy locally without secrets (dry run, no upload):

```sh
npx wrangler@4.161.0 deploy --dry-run -c site/wrangler.jsonc
```
