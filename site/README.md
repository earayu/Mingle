# mingle.build

The website: two static pages (English at `/`, Chinese at `/zh/`), `llms.txt` for AI agents, and real screenshots of the console. No framework; one generator script.

```text
site/scripts/copy.mjs          every word on the site, en and zh; keep the two in step
site/scripts/build.mjs         renders site/dist from copy.mjs and a release snapshot
site/scripts/screenshots.mjs   seeds a throwaway Mingle and shoots the console into site/img, light and dark
site/scripts/review.sh         screenshots the built site at desktop and phone widths into .site-review/
site/styles.css, site/main.js  the look (DESIGN.md's tokens) and the few behaviors (OS download, copy, motion)
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
site/scripts/review.sh                            # look at every image in .site-review/
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
