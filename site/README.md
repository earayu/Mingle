# mingle.build

The website: two static pages (English at `/`, Chinese at `/zh/`), `llms.txt` for AI agents, and real screenshots of the console. No framework; one generator script.

```text
site/scripts/copy.mjs          every word on the site, en and zh; keep the two in step
site/scripts/build.mjs         renders site/dist from copy.mjs (download links follow package.json's version)
site/scripts/screenshots.mjs   seeds a throwaway Mingle and shoots the console into site/img, light and dark
site/scripts/review.sh         screenshots the built site at desktop and phone widths into .site-review/
site/styles.css, site/main.js  the look (DESIGN.md's tokens) and the few behaviors (OS download, copy, motion)
site/wrangler.jsonc            deploys site/dist as a static-assets Worker on mingle.build and www.mingle.build
```

## Update

```sh
pnpm build && node site/scripts/screenshots.mjs   # only when the console changed; needs Google Chrome
node site/scripts/build.mjs
site/scripts/review.sh                            # look at every image in .site-review/
```

## Deploy

Needs a Cloudflare API token that can edit Workers and the `mingle.build` zone.

```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler deploy -c site/wrangler.jsonc
```

Rebuild and deploy after each release: the download buttons link to that version's files.
