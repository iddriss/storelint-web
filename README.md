# storelint-web

Hosted web app for **StoreLint** (https://storelint.embracetech.org): free zip scans with shareable reports, and the
"ship it for me" service page with its lead form. Conforms to `docs/STORELINT-SPEC.md` (Web contract, Finding
JSON schema, Pricing).

Stack: Node 22, TypeScript, [Hono](https://hono.dev) on `@hono/node-server`, `better-sqlite3`, `yauzl`.
Server-rendered HTML, one stylesheet, no front-end build step, no external assets.

## Routes

| Route | What |
| --- | --- |
| `GET /` | Landing: CLI instructions, zip upload form, what it checks, pricing, ship-it CTA |
| `POST /scan` | Multipart zip (`file`, <= 50 MB) -> extract -> `scan()` -> `303` to `/r/:id` |
| `POST /api/scan` | Same, returns `{ id, url, report }` as JSON (`201`) |
| `GET /r/:id` | HTML report grouped by severity, score, share link; `404` after 7 days |
| `GET /ship` | Service page: Play $149, App Store $199, both $299, fix rejections $99, lead form |
| `POST /ship` | Validates and stores the lead, renders thanks (no email is sent) |
| `POST /pay/:plan` | Hosted checkout (Flutterwave v3 or v4): creates a pending `orders` row and `303`s to the provider's payment page. Only when checkout is enabled (see `FLW_*` below) |
| `GET /pay/return` | Where Flutterwave sends the buyer back; verifies the transaction server-side, marks the order paid/failed/cancelled, renders the thanks page (with the intake checklist) or a retry page |
| `POST /webhooks/flutterwave` | `charge.completed` webhook; `401` unless the signature checks out (v3: `verif-hash` equals `FLW_WEBHOOK_HASH`; v4: `flutterwave-signature` is the base64 HMAC-SHA256 of the raw body with `FLW_WEBHOOK_HASH`); re-verifies by id and updates the order idempotently |
| `GET /health` | `{ "ok": true }` |
| `GET /admin?token=...` | HTML page listing orders and leads, newest first |
| `GET /admin/leads?token=...` | Leads as JSON; `401` unless `token` equals `ADMIN_TOKEN` |
| `GET /admin/orders?token=...` | Orders as JSON, same token |

`/scan` and `/api/scan` are rate limited to 10 requests per IP per hour (in memory); `/pay/*` has its own 10/hour
bucket. The client IP is the first `X-Forwarded-For` entry (Cloudflare -> Traefik -> app), falling back to the
socket address.

Uploads are extracted with only Node built-ins plus `yauzl` into a fresh temp dir that is removed after the scan.
Archives are rejected when they contain path traversal, absolute paths, symlinks, more than 20 000 entries, or
expand beyond 512 MB. Expired reports are deleted on startup and hourly.

## Scanner dependency

The actual checks live in the `storelint` package (`github:iddriss/storelint`), declared as an optional
dependency. `src/scanner.ts` imports it at startup; if the package is missing it falls back to a stub that returns
a schema-valid report with a single `info` finding (`app.scanner-unavailable`) and the landing page shows a notice.
Once the repo is public, `pnpm install` picks it up locally and the Docker build fetches it on every rebuild.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `/data` | Directory for `storelint.db` (SQLite, WAL). Mount a volume here. |
| `ADMIN_TOKEN` | unset | Token for `GET /admin/leads?token=...`. Unset means the endpoint always returns 401. |
| `PAY_LINK_PLAY` | unset | Payment link for the Google Play package ($149) |
| `PAY_LINK_IOS` | unset | Payment link for the App Store package ($199) |
| `PAY_LINK_BOTH` | unset | Payment link for both stores ($299) |
| `PAY_LINK_FIX` | unset | Payment link for "fix a rejection" ($99) |
| `FLW_API_VERSION` | auto | `v3` or `v4`. Unset: `v4` when `FLW_CLIENT_ID` is set, otherwise `v3` |
| `FLW_SECRET_KEY` | unset | v3 secret key (Settings -> API keys). Setting it turns on hosted checkout under v3. Under v4 it doubles as the client secret when `FLW_CLIENT_SECRET` is unset |
| `FLW_CLIENT_ID` | unset | v4 Client ID (`FLWPUBK-...-X`; Settings -> API keys -> V4 tab). Setting it selects v4 |
| `FLW_CLIENT_SECRET` | unset | v4 Client Secret (same tab) |
| `FLW_V4_PAYMENT_METHOD` | unset | v4 only: `payment_method.type` for the orchestrator charge (e.g. `opay`). v4 has no hosted checkout yet, so the price-card buttons stay off until this is set; see `docs/FLUTTERWAVE.md` |
| `FLW_TOKEN_URL` | `https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token` | v4 OAuth token endpoint; override only for local checks |
| `FLW_WEBHOOK_HASH` | unset | The "secret hash" you type into Settings -> Webhooks. v3 sends it back as `verif-hash`; v4 uses it as the HMAC key for `flutterwave-signature`. Unset means `/webhooks/flutterwave` always returns 401 |
| `FLW_CURRENCY` | `USD` | Currency the hosted page charges in. Prices are USD; only change this if the Flutterwave account cannot collect USD |
| `FLW_API_BASE` | per version | API base: v3 `https://api.flutterwave.com/v3`, v4 `https://f4bexperience.flutterwave.com` (sandbox: `https://developersandbox-api.flutterwave.com`). Override for sandbox or local checks |
| `PUBLIC_URL` | `https://storelint.embracetech.org` | Public origin used to build `redirect_url` (`${PUBLIC_URL}/pay/return`) |

Price-card buttons, in order of precedence: a `PAY_LINK_*` for that plan (external link) wins; otherwise, when
hosted checkout is enabled (v3: `FLW_SECRET_KEY`; v4: `FLW_CLIENT_ID` + secret + `FLW_V4_PAYMENT_METHOD`), the card is a
small form (email + honeypot) that posts to `/pay/:plan`; otherwise the button scrolls to the lead form with that
package pre-selected. Payment flow, dashboard setup and the verification rules
are in [`docs/FLUTTERWAVE.md`](docs/FLUTTERWAVE.md).

## Run locally

```sh
pnpm install          # storelint is optional; a 404 from GitHub is fine
pnpm test             # tsc + node --test
pnpm dev              # builds, then serves on http://localhost:3000 with DATA_DIR=./data
```

Or point at any directory: `DATA_DIR=/tmp/storelint PORT=8080 pnpm start` (after `pnpm build`).

## Docker

```sh
docker build -t storelint-web .
docker run --rm -p 3000:3000 -v storelint-data:/data -e ADMIN_TOKEN=change-me storelint-web
curl -s localhost:3000/health
```

The image is multi-stage on `node:22-slim`, runs as the `node` user, exposes `3000`, declares `VOLUME /data` and a
`HEALTHCHECK` against `/health`. On Coolify use the Dockerfile build pack, attach a persistent volume at `/data`,
and set the environment variables above.

## Layout

```
src/
  index.ts         entrypoint: config, SQLite, report cleanup (startup + hourly), HTTP server
  app.ts           Hono routes
  config.ts        env parsing
  db.ts            reports + leads + orders tables (better-sqlite3)
  flutterwave.ts   Flutterwave provider interface, v3 + v4 clients (fetch, OAuth token cache) + the paid/not-paid decision
  scanner.ts       storelint adapter with stub fallback + report normalisation
  scan-service.ts  upload -> temp dir -> extract -> scan -> store -> cleanup
  zip.ts           safe zip extraction (yauzl)
  ratelimit.ts     sliding-window in-memory limiter
  leads.ts         lead form validation
  views/           HTML rendering (layout, landing, report, ship/thanks, pay pages + intake checklist, admin)
public/            style.css, favicon.svg (served under /static/)
test/              node --test suites
```
