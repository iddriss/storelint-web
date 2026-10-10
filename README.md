# storelint-web

Hosted web app for **StoreLint** (https://storelint.embracetech.org): free zip scans with shareable reports, the
"ship it for me" service page with its lead form and hosted checkout, a private order page for each paying client,
an admin console, and transactional email. Conforms to `docs/STORELINT-SPEC.md` (Web contract, Finding JSON schema,
Pricing).

Stack: Node 22, TypeScript, [Hono](https://hono.dev) on `@hono/node-server`, `better-sqlite3`, `yauzl`, `nodemailer`.
Server-rendered HTML, one stylesheet, no front-end build step, no external assets besides the two web fonts.

## Routes

| Route | What |
| --- | --- |
| `GET /` | Landing: CLI instructions, zip upload form, what it checks, pricing, ship-it CTA |
| `POST /scan` | Multipart zip (`file`, <= 50 MB) -> extract -> `scan()` -> `303` to `/r/:id` |
| `POST /api/scan` | Same, returns `{ id, url, report }` as JSON (`201`) |
| `GET /r/:id` | HTML report grouped by severity, score, share link; `404` after 7 days |
| `GET /ship` | Service page: Play $149, App Store $199, both $299, fix rejections $99, lead form |
| `POST /ship` | Validates and stores the lead, emails the team and acknowledges the lead, renders thanks. 10 per IP per hour |
| `POST /pay/:plan` | Hosted checkout (Flutterwave v3 or v4): creates a pending `orders` row and `303`s to the provider's payment page. Only when checkout is enabled (see `FLW_*` below) |
| `GET /pay/return` | Where Flutterwave sends the buyer back; verifies the transaction server-side and marks the order paid/failed/cancelled. Paid: `303` to the client's private order page. Otherwise a retry page |
| `POST /webhooks/flutterwave` | `charge.completed` webhook; `401` unless the signature checks out (v3: `verif-hash` equals `FLW_WEBHOOK_HASH`; v4: `flutterwave-signature` is the base64 HMAC-SHA256 of the raw body with `FLW_WEBHOOK_HASH`); re-verifies by id and updates the order idempotently |
| `GET /o/:orderId/:token` | Client order page (no account): plan, payment, progress stepper, what happens next, intake form, timeline, message box. `404` unless the token matches |
| `POST /o/:orderId/:token/intake` | Saves the intake answers (editable until the build is submitted); rejects anything that looks like a secret |
| `POST /o/:orderId/:token/message` | Client message to the team, 10 per order per hour |
| `GET/POST /orders/find` | "Find my order": emails the private link(s) for the paid orders of an address; the response never says whether any exist |
| `GET /health` | `{ "ok": true }` |
| `GET /admin` | Login page, or the dashboard once signed in |
| `POST /admin/login`, `POST /admin/logout` | Password sign-in (5 failed attempts per IP per 15 min) and sign-out |
| `GET /admin/orders/:id` + `POST …/stage`, `/update`, `/note`, `/resend-link`, `/email`, `/cancel` | Order page and its actions |
| `GET/POST /admin/leads/:id` | Lead page: status, internal notes, reply link, pay links |
| `GET /admin/emails/:id`, `POST …/retry`, `POST /admin/test-email` | Email log entry, re-queue, test message |
| `GET /admin/api/leads`, `/admin/api/orders`, `/admin/api/summary` | JSON for automation: `Authorization: Bearer <ADMIN_TOKEN>` |

The old `?token=` access is gone: `/admin/leads?token=…` and `/admin/orders?token=…` answer `401`, and a token in a
query string is never read anywhere.

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
| `ADMIN_PASSWORD_HASH` | unset | Admin login password as `scrypt:16384:8:1:<salt>:<hash>`; generate it with `pnpm hash-password`. Preferred |
| `ADMIN_PASSWORD` | unset | Plain-text fallback for the admin login, used only when no valid `ADMIN_PASSWORD_HASH` is set. With neither, `/admin` answers `503` |
| `ADMIN_TOKEN` | unset | Bearer token for `GET /admin/api/*` (header only). Unset means those endpoints always return 401. It does not open the HTML console |
| `SMTP_HOST` | unset | SMTP server. Unset means no mail is sent; every message is recorded as `skipped` |
| `SMTP_PORT` | `587` | `465` uses implicit TLS; every other port uses STARTTLS (required, except on `25`) |
| `SMTP_USER` | unset | SMTP username. When set, `SMTP_PASS` is required too |
| `SMTP_PASS` | unset | SMTP password |
| `SMTP_FROM` | `SMTP_USER` | From address |
| `SMTP_FROM_NAME` | `StoreLint` | From display name |
| `NOTIFY_EMAIL` | `developers@embracetech.org` | Where internal notifications go. Also the address clients are told to invite to their repo and store consoles, and the Reply-To of client mail |
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
| `PUBLIC_URL` | `https://storelint.embracetech.org` | Public origin used to build `redirect_url` (`${PUBLIC_URL}/pay/return`) and every link in emails (client order pages, admin pages, pay links) |

An `SMTP_*` or `NOTIFY_EMAIL` value that still contains `{{` (an unresolved template from the hosting dashboard) is
treated as unset.

Price-card buttons, in order of precedence: a `PAY_LINK_*` for that plan (external link) wins; otherwise, when
hosted checkout is enabled (v3: `FLW_SECRET_KEY`; v4: `FLW_CLIENT_ID` + secret + `FLW_V4_PAYMENT_METHOD`), the card is a
small form (email + honeypot) that posts to `/pay/:plan`; otherwise the button scrolls to the lead form with that
package pre-selected. Payment flow, dashboard setup and the verification rules
are in [`docs/FLUTTERWAVE.md`](docs/FLUTTERWAVE.md).

## Admin console

`/admin` shows a login form. Set the password once:

```sh
pnpm hash-password                                   # type the password, press Enter; prints scrypt:16384:8:1:…
printf '%s' 'the password' | node dist/src/hash-password.js   # same thing inside the container / in a pipe
```

Put the printed line in `ADMIN_PASSWORD_HASH` and restart. The format has no `$`, so it can be pasted into Coolify or
an env file as is. The script never echoes or stores the password.

- **Sessions**: a random 32-byte id in the `sl_admin` cookie (`HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/admin`);
  only its SHA-256 is stored (`sessions` table). Sessions expire 12 hours after their last use. Because the cookie is
  `Secure`, sign-in needs HTTPS (browsers also accept it on `http://localhost`).
- **CSRF**: every admin POST carries a per-session token in a hidden field; a missing or wrong one is a `403`.
- **Headers**: `Cache-Control: no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer` on everything under `/admin`.
- **Dashboard**: tiles (new leads awaiting reply, paid orders awaiting intake, orders in progress, revenue this month
  and all time by currency), a "needs attention" list (paid with no intake after 24 h, leads not contacted after 24 h,
  unanswered client messages, failed emails), and Orders / Leads / Waitlist / Email log with status filters and search
  by email or id. "Send test email" queues a message to `NOTIFY_EMAIL` and lands on the email log.
- **Order page**: plan, amounts, payment status, provider reference, client email (editable while blank or a
  placeholder), intake answers, full timeline. Actions: set stage, post a client-visible update (emailed), add an
  internal note (never shown or emailed to the client), resend the order link, mark cancelled (optionally "refunded
  outside this system", which removes it from revenue).
- **Lead page**: all fields, status `new | contacted | won | lost`, internal notes, a prefilled `mailto:` reply link
  and a copyable pay link per plan (`${PUBLIC_URL}/ship?plan=<plan>#prices`).
- **Automation**: `curl -H "Authorization: Bearer $ADMIN_TOKEN" $PUBLIC_URL/admin/api/summary` (also `/leads`,
  `/orders`). Order JSON leaves out the clients' access tokens.

## Orders, stages and the client page

Payment status (`orders.status`: `pending | paid | failed | cancelled`) and delivery stage (`orders.stage`) are
separate. A paid order moves through

`paid` → `intake_received` → `in_progress` → `submitted` → `in_review` → `live`

plus `needs_client` (blocked on the client; the reason is shown to them as a banner) and `cancelled`. Every change is
an `order_events` row (`actor` admin/client/system, `visibility` client/internal); the client page renders the
client-visible ones, the admin page renders all of them.

Each order has an unguessable `access_token` (32 random bytes, base64url). The client page lives at
`/o/<order id>/<token>`: constant-time comparison, the same `404` for a wrong token and an unknown order, 20 wrong
links per IP per hour, and `noindex` / `no-store` / `no-referrer` responses. After a verified payment `/pay/return`
redirects there (see [`docs/FLUTTERWAVE.md`](docs/FLUTTERWAVE.md) for when), and the receipt email carries the link.

The intake form asks for the app name, framework, platforms, how the code is shared and its link, existing store
listings, whether the developer accounts exist, a target date and notes. It never asks for credentials: the page tells
the client to invite `NOTIFY_EMAIL` to the repo, Play Console and App Store Connect, and input that looks like a
secret (private-key headers, known token prefixes, `password: …`, long key-shaped strings, links with a password) is
rejected with a message and never stored. Submitting moves `paid` → `intake_received`, logs an event and emails the
team; the form stays editable until the stage reaches `submitted`.

"Find my order" (`/orders/find`, linked from the footer and `/ship`) emails the link(s) for the paid orders of an
address and always shows the same page. Limits: 5 requests per IP per hour, one email per address per 10 minutes.

## Email

All mail goes through an outbox (`emails` table) so a request never waits on SMTP or fails because of it. A worker
sends queued mail right after it is queued and every 60 s, retries up to 5 times (after 1, 5, 15 and 60 minutes), then
marks the row `failed` with the error; failed mail shows on the dashboard and can be queued again from its log page.
Without SMTP settings rows are stored as `skipped`, which makes the log a preview of what would have been sent. One
startup line reports the setup without printing any value:

```
[smtp] configured: host=smtp.example.com port=465 secure=yes user=yes pass=yes from=yes
```

| Kind | To | When |
| --- | --- | --- |
| `lead_new`, `waitlist_new` | team | new service lead / deep-scan waitlist signup |
| `lead_ack`, `waitlist_ack` | lead | "we received your request, a developer replies within 24 hours" / one-line waitlist confirmation |
| `order_paid` | team | an order verified as paid (plan, amount, email, admin link) |
| `order_receipt` | client | same moment: receipt, private order link, what to do next |
| `payment_failed` | team | a payment verified as failed (low priority) |
| `intake`, `client_message` | team | the client submitted or updated the intake / sent a message |
| `order_update` | client | the team changed the stage or posted a client-visible update |
| `order_links` | client | "find my order", or "resend order link" in the admin |
| `test` | team | "Send test email" on the dashboard |

Team notifications set Reply-To to the client's address when one is known; client mail sets it to `NOTIFY_EMAIL`.
Bodies are plain text plus a small inline-styled HTML version with no remote images. Nothing is ever sent to a
checkout placeholder address (`orders+sl_…@…`), and internal notes never leave the admin page.

## Database and migrations

`DATA_DIR/storelint.db` (SQLite, WAL). Tables: `reports`, `leads`, `orders`, `order_events`, `emails`, `sessions`.
Migrations run on every start inside one transaction and are idempotent: missing tables are created, and each column
added since the first release (`leads.status/notes/updated_at`, `orders.stage/stage_prev/needs_client_reason/
access_token/intake_json/intake_at/paid_at/refunded_at`) is added with `ALTER TABLE … ADD COLUMN` only when
`PRAGMA table_info` does not list it. A database from the first release upgrades in place: every order gets an access
token, orders that were already paid get `stage = paid`, `paid_at` (from their last update) and a "Payment received"
timeline event, and leads default to `new`. The old build keeps working against the upgraded file, so a rolling
deploy or a rollback is safe.

## Run locally

```sh
pnpm install          # storelint is optional; a 404 from GitHub is fine
pnpm test             # tsc + node --test
pnpm dev              # builds, then serves on http://localhost:3000 with DATA_DIR=./data
```

Or point at any directory: `DATA_DIR=/tmp/storelint PORT=8080 pnpm start` (after `pnpm build`). To use the admin
locally add `ADMIN_PASSWORD=something PUBLIC_URL=http://localhost:8080`; without `SMTP_*` every email is recorded as
`skipped` and can be read in the email log.

## Docker

```sh
docker build -t storelint-web .
docker run --rm -p 3000:3000 -v storelint-data:/data -e ADMIN_PASSWORD_HASH='scrypt:16384:8:1:…' storelint-web
curl -s localhost:3000/health
```

The image is multi-stage on `node:22-slim`, runs as the `node` user, exposes `3000`, declares `VOLUME /data` and a
`HEALTHCHECK` against `/health`. On Coolify use the Dockerfile build pack, attach a persistent volume at `/data`,
and set the environment variables above.

## Layout

```
src/
  index.ts         entrypoint: config, SQLite, cleanup (startup + hourly), mail worker, HTTP server
  app.ts           public routes (scan, ship, pay, webhook) and wiring
  routes/admin.ts  admin login, dashboard, order/lead/email pages and actions, bearer JSON API
  routes/client.ts client order page, intake, messages, find-my-order
  http.ts          shared request helpers (client IP, form parsing, private-page headers)
  config.ts        env parsing
  db.ts            schema, migrations and queries (better-sqlite3)
  auth.ts          sessions, CSRF tokens, cookies, constant-time compares
  password.ts      scrypt hash / verify;  hash-password.ts  the `pnpm hash-password` script
  mailer.ts        outbox worker + nodemailer transport
  emails.ts        email bodies (text + HTML);  notify.ts  every email trigger in one place
  stages.ts        delivery stages, labels and "what happens next" copy
  intake-form.ts   intake validation and secret detection
  addresses.ts     email address helpers (placeholder detection)
  flutterwave.ts   Flutterwave provider interface, v3 + v4 clients (fetch, OAuth token cache) + the paid/not-paid decision
  scanner.ts       storelint adapter with stub fallback + report normalisation
  scan-service.ts  upload -> temp dir -> extract -> scan -> store -> cleanup
  zip.ts           safe zip extraction (yauzl)
  ratelimit.ts     sliding-window in-memory limiter
  leads.ts         lead form validation
  views/           HTML rendering (layout, landing, report, ship/thanks, pay pages + intake checklist, order page, admin)
public/            style.css, favicon.svg (served under /static/)
test/              node --test suites
```
