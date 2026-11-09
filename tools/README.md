# HalalVest data tools

Two separate things live here. They solve different problems.

## 1. `update-prices.mjs` — refresh the embedded datasets (build time)

Rewrites the `PRICES`, `MONTHLY_PRICES` and `NIFTY50_MONTHLY` blocks inside
`index.html`. Run it when you want the committed baseline to move.

```bash
node tools/update-prices.mjs --dry-run      # fetch, validate, report, write nothing
node tools/update-prices.mjs                # actually rewrite index.html
node tools/update-prices.mjs --only TCS,INFY
node tools/lib.test.mjs                     # 18 tests, no network
```

Fetches daily adjusted closes and derives both datasets from that one source:

| dataset | definition |
| --- | --- |
| `PRICES` | last session on or before 31 March each year |
| `MONTHLY_PRICES` | last session of each calendar month |

**Read the dry-run report before the first real run.** The committed data was
originally built from two independent fetches, so its annual and monthly
series disagree in 377 places and 18 annual points predate the monthly series.
Deriving both from one pull removes that skew, which means some historical
values will change.

Safety behaviour: a ticker that fails to fetch keeps its committed data, and
the run aborts without writing if more than half the universe fails.

## 2. `worker.js` — live price proxy (runtime)

Yahoo's chart endpoint sends no `Access-Control-Allow-Origin`, so the page
cannot call it directly from a browser. This Cloudflare Worker fetches
server-side, adds the header, and caches for 6 hours so Yahoo sees a trickle
of traffic rather than one request per visitor.

```bash
npm i -g wrangler
wrangler login
wrangler deploy tools/worker.js --name halalvest-prices --compatibility-date 2026-01-01
```

Then set the deployed URL in `index.html`:

```js
const LIVE_ENDPOINT = 'https://halalvest-prices.<you>.workers.dev';
```

Leave `LIVE_ENDPOINT` empty and the site behaves exactly as before — embedded
data only, indicator hidden. The live refresh is strictly additive: the page
renders from embedded data first and never blocks on the network, so a failed
or slow fetch degrades to "showing data as of <month>" rather than a blank page.

The Worker only accepts `*.NS` symbols and `^NSEI`, caps requests at 40 symbols,
and refuses to cache a mostly-failed response so an upstream outage can't get
pinned for hours.

## Where the numbers come from

Note the unresolved discrepancy: the About page credits Yahoo Finance, but
commit `a24ff23` says the source moved to Stooq. Both tools here use Yahoo.
If Stooq is in fact the true source of the committed data, the first
`update-prices.mjs` run will show larger-than-expected revisions.
