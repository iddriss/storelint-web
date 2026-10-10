# Flutterwave checkout (v3 and v4)

StoreLint collects payment for the "ship it for me" packages through Flutterwave. No SDK; `src/flutterwave.ts`
calls the REST API with `fetch` and exposes one small provider interface (`createPayment`, `verifyTransaction`,
`verifyWebhook`, `parseWebhook`) with two implementations. The routes in `src/app.ts` only see the interface.

## Which API version

| | v3 | v4 |
| --- | --- | --- |
| Credential | Secret key (`FLWSECK-…`) | Client ID (`FLWPUBK-…-X`) + Client Secret (+ an encryption key we do not need) |
| Auth | `Authorization: Bearer <secret key>` | OAuth 2.0 client-credentials token, `Authorization: Bearer <access_token>` |
| Base URL | `https://api.flutterwave.com/v3` | production `https://f4bexperience.flutterwave.com`, sandbox `https://developersandbox-api.flutterwave.com` |
| Hosted page | `POST /payments` ("Flutterwave Standard") returns `data.link` | **None yet.** `POST /orchestration/direct-charges` with a concrete `payment_method.type` returns `data.next_action.redirect_url.url` for redirect-based methods |
| Verify | `GET /transactions/{id}/verify` | `GET /charges/{id}` |
| Webhook | `verif-hash` header equals the secret hash | `flutterwave-signature` header = base64(HMAC-SHA256(secret hash, raw body)) |
| Success status | `successful` | `succeeded` (mapped to `successful` in `normalizeV4Charge`) |

An account uses one version at a time. The dashboard shows which one under **Settings → API keys** (v3 shows
Public/Secret/Encryption key; v4 shows Client ID / Client Secret / Encryption key behind the *Switch to v4 live API
keys* button). Once switched to v4, v3 secret keys stop working for that account.

### What v4 cannot do today (read this before switching)

Flutterwave's v4 docs have no hosted checkout, payment-link or "Standard" page: the v4 docs index
(https://developer.flutterwave.com/v4.0.0/llms.txt, fetched 2026-10-10) lists only direct charge methods (card,
mobile money, bank transfer, Pay with Bank NG, USSD, OPay) plus the general and orchestrator flows, and a Flutterwave
engineer wrote in the comments of https://dev.to/flutterwaveeng/how-to-collect-payments-using-the-v4-apis-4lhp that
"v4 Checkout that supports payment link and hosted collection is still in work".

The orchestrator (`POST /orchestration/direct-charges`) needs a specific `payment_method.type` in the request:

- `card` needs the card number/expiry/CVV encrypted with the encryption key, i.e. we would have to collect card data
  on our own page (PCI scope). Not an option here.
- `mobile_money` needs the phone number and network; `ussd` and `bank_transfer` return offline payment instructions.
- `opay` is the only documented type that returns a `redirect_url` next action with nothing but the customer's email,
  and it is NGN-only (https://developer.flutterwave.com/v4.0.0/docs/opay).

So under v4 the buttons stay off (`checkout: off (flutterwave v4 configured, …)` in the startup line) until
`FLW_V4_PAYMENT_METHOD` names a redirect-capable type. Verification, webhooks, the admin console and the client order pages work regardless. For a
USD service page the practical choices are: keep the account on v3 keys (`FLW_API_VERSION=v3` + `FLW_SECRET_KEY`), use
`PAY_LINK_*` with dashboard payment links, or wait for v4 Checkout and then wire its endpoint into
`createFlutterwaveV4Client.createPayment` (one function).

## Environment

| Variable | Version | Where it comes from |
| --- | --- | --- |
| `FLW_API_VERSION` | both | `v3` or `v4`. Unset: `v4` if `FLW_CLIENT_ID` is set, else `v3`. Anything else fails at startup |
| `FLW_SECRET_KEY` | v3 | Settings → API keys → *Secret key*. Under v4 it is accepted as the client secret when `FLW_CLIENT_SECRET` is unset |
| `FLW_CLIENT_ID` | v4 | Settings → API keys → V4 → *Client ID* (`FLWPUBK-…-X`) |
| `FLW_CLIENT_SECRET` | v4 | Settings → API keys → V4 → *Client Secret* |
| `FLW_TOKEN_URL` | v4 | OAuth token endpoint, default `https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token`; override only for local checks |
| `FLW_V4_PAYMENT_METHOD` | v4 | `payment_method.type` sent to the orchestrator (`opay`, …). Unset keeps hosted checkout off under v4 |
| `FLW_API_BASE` | both | Override of the base URL. Defaults: v3 `https://api.flutterwave.com/v3`; v4 `https://f4bexperience.flutterwave.com`. Use `https://developersandbox-api.flutterwave.com` with sandbox credentials |
| `FLW_WEBHOOK_HASH` | both | Settings → Webhooks → *Secret hash* (you choose it). v3 compares it to `verif-hash`; v4 uses it as the HMAC key for `flutterwave-signature` |
| `FLW_CURRENCY` | both | Currency charged (default `USD`) |
| `PUBLIC_URL` | both | Origin for `redirect_url` (`${PUBLIC_URL}/pay/return`) |

The encryption key shown in the dashboard is only needed for encrypting card data in direct card charges; this
integration never sends card data, so it is not read.

## Flow

1. Buyer submits the price-card form (`POST /pay/:plan`, optional `email`, honeypot `website`).
2. We insert an `orders` row (`status=pending`, `tx_ref = order id`, e.g. `sl_3f9a…`) and ask the provider for a page:
   - **v3**: `POST {FLW_API_BASE}/payments` with `tx_ref`, `amount` (major units), `currency`, `redirect_url`,
     `customer.email`, `customizations`, `meta.order_id/plan`. The response's `data.link` is the hosted page.
   - **v4**: get (or reuse) an access token, then `POST {FLW_API_BASE}/orchestration/direct-charges` with
     `amount`, `currency`, `reference = order id`, `redirect_url` (we append `?tx_ref=<order id>` ourselves, because
     the docs do not say what v4 appends on return), `customer.email`, `payment_method.type = FLW_V4_PAYMENT_METHOD`,
     `meta`. Headers: `Authorization: Bearer`, `Content-Type: application/json`, `X-Idempotency-Key` (fresh per
     order, reused on the 401 retry), `X-Trace-Id`. The response must carry
     `data.next_action.type == "redirect_url"`; its `redirect_url.url` is where the buyer goes, and `data.id`
     (`chg_…`) is stored on the order as `flw_id` right away. Any other `next_action` is an error page + `failed` order.
   - If the buyer left the email blank we send `orders+<order id>@<PUBLIC_URL host>` and later copy the real address
     from the verified transaction when the provider returns one (v4 `GET /charges/{id}` returns `customer_id`
     only, so nothing is copied there).
3. The link is returned to the browser as a `303`. If the API call fails we render `renderPayError`, log the provider
   message and mark the order `failed` with the error in `raw_json`.
4. The buyer comes back to `/pay/return`. We **never trust the query string**: v3 sends
   `?status=…&tx_ref=…&transaction_id=…`; v4 only guarantees our own `?tx_ref=`. The transaction id to verify is
   `transaction_id` from the query when present, else the `flw_id` stored at creation (always set under v4). If neither
   exists (v3 cancel before paying) the order becomes `cancelled`/`failed` without an API call. Otherwise we call the
   verify endpoint and apply `judgePayment` (below). A provider status of `pending` keeps the order `pending` and
   shows the retry page; the webhook or a later visit settles it.
5. Flutterwave also posts `charge.completed` to `POST /webhooks/flutterwave`:
   - **v3** body `{ event: "charge.completed", data: { id, tx_ref, … } }`, header `verif-hash` must equal
     `FLW_WEBHOOK_HASH` (constant-time compare).
   - **v4** body `{ id: "wbk_…", timestamp, type: "charge.completed", data: { id: "chg_…", reference, status, amount,
     currency, customer, … } }`, header `flutterwave-signature`. We recompute `base64(HMAC-SHA256(FLW_WEBHOOK_HASH,
     raw body))` and compare in constant time. The same docs page's Express/Laravel/Django samples compare the header
     to the secret hash directly, so a header that equals the hash verbatim is accepted too. Either way the body is
     never trusted: we look the order up by `reference` and re-fetch `GET /charges/{data.id}`.
   - 401 when the header is missing/wrong or `FLW_WEBHOOK_HASH` is unset, 400 for invalid JSON, 200 + `ignored` for
     other event types and unknown orders. Anything other than 200 makes Flutterwave retry (3 times, 30 min apart, if
     retries are enabled in the dashboard; requests time out after 60 s).

### `judgePayment` (the only place that says "paid")

An order is `paid` only when the **verified** transaction has `status == "successful"` (v4 `succeeded` is normalized
to that), `tx_ref`/`reference` equal to the order id, `currency` equal to the order currency, and
`amount >= order amount` (the docs allow overpayment; we record it, refund the difference manually). Anything else is
`failed`, `cancelled` (v3 `cancelled`, v4 `voided`) or stays `pending`.

`Store.updateOrder` never downgrades a `paid` order, so the return page and webhook can race or replay safely, and a
paid order short-circuits before any further API call.

### What happens once an order is paid

The first transition to `paid` (whichever of the return page or the webhook gets there first; `updateOrder` reports
`changed` exactly once) does all of this in one place:

- the order gets its delivery stage (`stage = paid`, `paid_at`) and the first timeline event (`order_events`);
- the team is emailed (`order_paid`, Reply-To the buyer) with a link to `/admin/orders/<id>`;
- the buyer is emailed a receipt (`order_receipt`) with the private order page `/o/<order id>/<access token>` and the
  next step (fill in the intake there). No email goes to a blank or placeholder (`orders+…@`) address; add the real
  one on the admin order page and use "Resend order link".

A verification that comes back as not paid (`failed`) emails the team only (`payment_failed`, low priority).
Nothing is emailed for a cancelled checkout or while a payment is `pending`.

`GET /pay/return` for a paid order then redirects (`303`) to the private order page instead of rendering a thank-you
page. Because `tx_ref` is not a secret (the provider prints it on receipts), the redirect is only given when

- the browser carries the `sl_pay` cookie that `POST /pay/:plan` set for this order (HttpOnly, Secure,
  SameSite=Lax, `Path=/pay`, 24 h; an HMAC of the order's access token, so it cannot be forged from the order id), or
- the payment verified within the last 30 minutes (`PAID_RETURN_GRACE_MS`), which covers browsers that drop the
  cookie on the way back from the provider.

Anyone else who opens `/pay/return?tx_ref=…` for a paid order sees a plain "this order is paid" page without the
link, and can have it emailed through `/orders/find`. Unpaid, failed, cancelled and pending returns render the same
retry pages as before.

### v4 token handling

`POST {FLW_TOKEN_URL}` with `application/x-www-form-urlencoded` body `client_id`, `client_secret`,
`grant_type=client_credentials` returns `{ access_token, expires_in: 600, token_type: "Bearer", … }`. The client
caches the token and refreshes it 60 s before `expires_in` (the docs say "at least one minute before"); concurrent
requests share one in-flight refresh. A `401` from the API drops the cached token, fetches a new one and retries the
request exactly once with the same `X-Idempotency-Key`; a second `401` is reported as a provider error.

## Dashboard setup (owner)

v4 (current account state):

1. **Settings → API keys**: if the page still shows Public/Secret/Encryption key, click *Switch to v4 live API keys*.
   Copy *Client ID* into `FLW_CLIENT_ID` and *Client Secret* into `FLW_CLIENT_SECRET` (or leave the secret in
   `FLW_SECRET_KEY`; it is picked up as the client secret). Leave `FLW_API_VERSION` unset or set it to `v4`.
   The encryption key is not needed.
2. **Settings → Webhooks**: URL `https://storelint.embracetech.org/webhooks/flutterwave`, type a long random string
   into *Secret hash* and put the same string in `FLW_WEBHOOK_HASH`. Enable retries.
3. Decide on `FLW_V4_PAYMENT_METHOD` per the limits above; without it the price cards fall back to the lead form.
4. Sandbox check: the developer sandbox (https://developer.flutterwave.com/v4.0.0/docs/environments) has its own
   Client ID/Secret; run with `FLW_API_BASE=https://developersandbox-api.flutterwave.com`.

v3 (if the account is switched back):

1. **Settings → API keys**: *Secret key* → `FLW_SECRET_KEY`; set `FLW_API_VERSION=v3` if `FLW_CLIENT_ID` is also set.
2. **Settings → Webhooks** as above (`verif-hash` compare).

Nothing here creates or stores keys in the repo; the app reads them from the environment at startup and logs
`checkout: flutterwave v4 USD` / `flutterwave v3 USD` / `off (…)` in its startup line.

## Sources (fetched 2026-10-10)

v4, official (pages render client-side; the `/v4.0.0/` paths return the right version):

- Environments / base URLs / where credentials live: https://developer.flutterwave.com/v4.0.0/docs/environments
  ("set `https://developersandbox-api.flutterwave.com` as your base URL", "use `https://f4bexperience.flutterwave.com/`
  as the base URL" for production; *Switch to v4 live API keys* under Settings → API Keys)
- Authentication (token endpoint, 10-minute TTL, refresh one minute early):
  https://developer.flutterwave.com/v4.0.0/docs/authentication
- Request headers (`Authorization` and `X-Idempotency-Key` listed as mandatory; `X-Trace-Id`, `X-Scenario-Key`,
  `Content-Type` optional; keys alphanumeric 12–255 chars): https://developer.flutterwave.com/v4.0.0/docs/api-headers,
  https://developer.flutterwave.com/v4.0.0/docs/idempotency
- Orchestrator flow (`POST /orchestration/direct-charges`, `next_action` types, verify step):
  https://developer.flutterwave.com/v4.0.0/docs/payment-orchestrator-flow
- General flow (customers → payment methods → charges): https://developer.flutterwave.com/v4.0.0/docs/main-payment-flow
- Retrieve a charge (`GET /charges/{id}`; status enum `succeeded | pending | failed | voided`; no reference filter):
  https://developer.flutterwave.com/v4.0.0/reference/charges_get
- Webhooks (`flutterwave-signature`, HMAC-SHA256 base64, payload with `type`/`id`/`timestamp`/`data`):
  https://developer.flutterwave.com/v4.0.0/docs/webhooks
- OPay (NGN only, redirect next action): https://developer.flutterwave.com/v4.0.0/docs/opay
- Testing / `X-Scenario-Key`: https://developer.flutterwave.com/v4.0.0/docs/testing
- v4 docs index: https://developer.flutterwave.com/v4.0.0/llms.txt

v4, secondary:

- Flutterwave Engineering on dev.to: https://dev.to/flutterwaveeng/a-quick-guide-to-developer-onboarding-in-v4-4dcj,
  https://dev.to/flutterwaveeng/how-to-collect-payments-using-the-payment-orchestrator-flow-in-v4-458k,
  https://dev.to/flutterwaveeng/how-to-collect-payments-using-the-v4-apis-4lhp (comment: v4 Checkout "still in work"),
  https://dev.to/flutterwaveeng/introducing-the-flutterwave-v4-api-faster-safer-easier-to-integrate-2dc9
- Third-party OpenAPI mirror listing `https://api.flutterwave.cloud/f4b/production` and `…/f4b/sandbox` as servers:
  https://github.com/api-evangelist/flutterwave (not confirmed by the official environments page; if the official
  host ever rejects requests, try it via `FLW_API_BASE`)

v3:

- Standard checkout: https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1
- Transaction verification: https://developer.flutterwave.com/docs/transaction-verification
- Webhooks: https://developer.flutterwave.com/v3.0/docs/webhooks
- Ghana payment methods / KYC: https://developer.flutterwave.com/docs/ghana-1

## Not confirmed from the docs (and what we do about it)

- **Which query parameters v4 appends to `redirect_url`.** Undocumented. We add `tx_ref` ourselves and verify by the
  charge id stored at creation, so the return page works even if Flutterwave appends nothing.
- **Verify by reference in v4.** `GET /charges` only documents `limit`/`page`; no reference filter. We always have the
  charge id (stored at creation and present in the webhook), so lookup by reference is not needed.
- **Webhook signature form.** The v4 page describes HMAC-SHA256 base64 but its framework samples compare the plain
  hash; both are accepted, and neither grants "paid" without a fresh `GET /charges/{id}`.
- **Production base URL.** Official page: `f4bexperience.flutterwave.com`; third-party specs: `api.flutterwave.cloud/f4b/production`.
  Default is the official one; `FLW_API_BASE` overrides.
- **Whether v4 appends `transaction_id`-style ids anywhere, and the `customer` shape in `GET /charges/{id}`** (the
  reference says `customer_id`, the guide's example shows `customer: "cus_…"`). We only copy an email when the
  response has a `customer` object with an `email` string.
- **USD collection for a Ghana merchant** (unchanged from v3): confirm in the dashboard / with support before going
  live. If USD is refused, `FLW_CURRENCY=GHS` with repriced tiers in `src/views/ship.ts`, or `PAY_LINK_*`.

## Local check without real keys

```sh
pnpm build
# v4, no network (token endpoint unreachable -> 502 + error page, nothing leaves the box)
FLW_CLIENT_ID=FLWPUBK-test-X FLW_CLIENT_SECRET=test-only FLW_WEBHOOK_HASH=test FLW_V4_PAYMENT_METHOD=opay \
  FLW_TOKEN_URL=http://127.0.0.1:1/token FLW_API_BASE=http://127.0.0.1:1 DATA_DIR=/tmp/sl PORT=3999 node dist/src/index.js
curl -s localhost:3999/ship | grep -o 'action="/pay/[a-z]*"'
curl -s -o /dev/null -w '%{http_code}\n' -d email=a@b.co localhost:3999/pay/play   # 502
# v3 as before
FLW_API_VERSION=v3 FLW_SECRET_KEY=test-only FLW_WEBHOOK_HASH=test FLW_API_BASE=http://127.0.0.1:1 DATA_DIR=/tmp/sl PORT=3999 node dist/src/index.js
```
