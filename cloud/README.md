# Phase 0 deploy (try.md)

Live: https://ml-host.arunofficial2023.workers.dev

One Cloudflare Worker (`src/worker.js`) serves `../site` and `/api/*` (see `docs/endpoint.md`). Cloud runs use Workers AI; events go to D1. The deploy config is `wrangler.toml` at the repo root. Keep it the only one: a second `wrangler.json(c)` higher up wins and silently deploys without bindings.

```sh
# from the repo root
npx wrangler deploy
npx wrangler d1 execute locallink-try --remote --file cloud/schema.sql   # first time only
node cloud/test.mjs                                                     # event filter + device check rules
```

Spend control: `DAILY_CAP` cloud calls/day + 10/min per IP. On the Workers free plan, Workers AI stops at the free daily allocation, so cloud cost is ₹0; on a paid plan keep `DAILY_CAP` low.

Results: `npx wrangler d1 execute locallink-try --remote --file cloud/queries.sql`

Hugging Face rejects model downloads whose Referer is a `*.workers.dev` page, so `site/_headers` sets `Referrer-Policy: no-referrer`. Localhost isn't affected, so local tests won't catch a regression; test on the deployed URL.

Local, no login: `npx wrangler d1 execute locallink-try --local -c cloud/wrangler.localtest.toml --file cloud/schema.sql`, then `npx wrangler dev -c cloud/wrangler.localtest.toml`. That config has no AI binding, so cloud returns 502, and it sets `DAILY_CAP=2`.
