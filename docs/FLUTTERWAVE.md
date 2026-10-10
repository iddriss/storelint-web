# Flutterwave hosted checkout

StoreLint collects payment for the "ship it for me" packages through Flutterwave's hosted page
("Flutterwave Standard"). No SDK; `src/flutterwave.ts` calls the v3 REST API with `fetch`.

## Which API version

Flutterwave currently documents two generations:

- **v3** (`https://api.flutterwave.com/v3`, `Authorization: Bearer <secret key>`). Still the version the
  Standard, verification and webhook guides describe, and the one a dashboard "secret key" works with.
- **v4** (`https://api.flutterwave.cloud/f4b/production`, OAuth 2.0 client-credentials tokens from a client id /
  client secret). Flutterwave's FAQ says an account uses one version at a time, that v3 is not being deprecated
  immediately, and that notice will be given before any deprecation; the versioning page says versions older than
  12 months stop receiving updates. Several v3 endpoints have no v4 equivalent yet.

This integration uses **v3** because the owner's credential is a dashboard secret key and v3 is the version the
Standard-checkout docs are written against (checked 2026-10-10). If the account is ever switched to v4 in the
dashboard, `src/flutterwave.ts` is the only file to change (token exchange + new base URL + `flutterwave-signature`
HMAC on webhooks instead of the plain `verif-hash` compare).

Sources (fetched 2026-10-10 unless noted):

- Standard checkout: https://developer.flutterwave.com/v3.0/docs/flutterwave-standard-1
  (the newer path https://developer.flutterwave.com/docs/collecting-payments/standard is the same guide; it
  returned 404 to our fetcher on the day, so the v3.0 mirror is the one read)
- Transaction verification: https://developer.flutterwave.com/docs/transaction-verification
- Webhooks: https://developer.flutterwave.com/docs/webhooks (and https://developer.flutterwave.com/v3.0/docs/webhooks)
- Versioning / v4: https://developer.flutterwave.com/docs/versioning,
  https://dev.to/flutterwaveeng/a-quick-guide-to-developer-onboarding-in-v4-4dcj (surfaced by search, summarised
  there; the versioning page itself 404'd to our fetcher)
- Ghana payment methods / KYC: https://developer.flutterwave.com/docs/ghana-1

## Flow

1. Buyer submits the price-card form (`POST /pay/:plan`, optional `email`, honeypot `website`).
2. We insert an `orders` row (`status=pending`, `tx_ref = order id`, e.g. `sl_3f9a...`) and call
   `POST {FLW_API_BASE}/payments` with:
   - `tx_ref` = order id (unique per transaction, as required)
   - `amount` in major units (149 for $149), `currency` = `FLW_CURRENCY` (default `USD`)
   - `redirect_url` = `${PUBLIC_URL}/pay/return`
   - `customer.email` (required by Flutterwave). If the buyer left it blank we send a placeholder
     `orders+<order id>@<PUBLIC_URL host>` and later copy the real address from the verified transaction's
     `customer.email` if Flutterwave reports a different one. Because the hosted page may not let the buyer edit
     the prefilled email, the form marks the field `required` in the browser; the placeholder is a server-side
     fallback only. The paid page tells buyers with no email on file to contact us quoting the order id.
   - `customizations.title` = "StoreLint release ops", `customizations.description` = plan title and price
   - `meta.order_id`, `meta.plan`
3. The response's `data.link` (hosted page) is returned to the browser as a `303`. If the API call fails we render
   `renderPayError`, log the provider message and mark the order `failed` with the error in `raw_json`.
4. Flutterwave redirects the buyer to `/pay/return?status=…&tx_ref=…&transaction_id=…`. We **never trust the
   query string**: if a `transaction_id` is present we call `GET /transactions/{id}/verify` and apply
   `judgePayment` (below). Without a `transaction_id` (cancelled before paying) the order becomes `cancelled`
   or `failed` and the retry page is shown.
5. Flutterwave also posts `charge.completed` to `POST /webhooks/flutterwave`. We compare the `verif-hash` header to
   `FLW_WEBHOOK_HASH` with a constant-time compare (401 on mismatch or when the env var is unset), look the order up
   by `data.tx_ref`, re-verify by `data.id` through the same verify endpoint, and update the order. Any response
   other than 200 makes Flutterwave retry (3 times, 30 min apart, if retries are enabled in the dashboard).

### `judgePayment` (the only place that says "paid")

An order is `paid` only when the **verified** transaction has `status == "successful"`, `tx_ref` equal to the
order id, `currency` equal to the order currency, and `amount >= order amount` (the docs allow overpayment; we
record it, refund the difference manually). Anything else is `failed` (or `cancelled` when Flutterwave reports
`cancelled`).

`Store.updateOrder` never downgrades a `paid` order, so the return page and webhook can race or replay safely, and
a paid order short-circuits before any further API call.

## Dashboard setup (owner)

1. **Settings -> API keys**: copy the *Secret key* into the deployment env as `FLW_SECRET_KEY`. Use test-mode
   keys first (`FLWSECK_TEST-…`) with the dashboard's test-mode toggle, then switch to the live key.
2. **Settings -> Webhooks**: set the URL to `https://storelint.embracetech.org/webhooks/flutterwave`, type a long
   random string into *Secret hash* and put the same string in `FLW_WEBHOOK_HASH`. Enable "receive webhook
   response in JSON" and retries if those options are shown.
3. Optionally `FLW_CURRENCY` (default `USD`) and `PUBLIC_URL` (default `https://storelint.embracetech.org`).
4. Leave `PAY_LINK_*` unset unless you want a specific plan to use an external payment link instead (it wins over
   hosted checkout for that plan).

Nothing here creates or stores keys in the repo; the app reads them from the environment at startup and logs
`checkout: flutterwave USD` (or `checkout: off`) in its startup line.

## Open questions

- **USD collection for a Ghana merchant.** The Ghana page lists cards, mobile money and virtual accounts but says
  nothing about collection currency. Community material describes multi-currency checkout as "buyer pays in their
  currency, merchant settles in domestic currency" (GHS for Ghana), and third-party reviews list Ghana as a
  GHS-settlement market. Whether a Ghana account can present a USD-priced hosted page to international cards, what
  the FX and international-card fees are, and whether settlement is GHS or can be USD must be confirmed in the
  dashboard (currency settings) or with Flutterwave support before going live. If USD is refused the quick
  fallback is `FLW_CURRENCY=GHS` with repriced tiers (`amountCents` in `src/views/ship.ts`), or a `PAY_LINK_*`.
- The hosted page's behaviour with a prefilled `customer.email` (editable or not) was not verified; see step 2.
- v3 remains documented as supported, but Flutterwave's 12-month support window means the account's API version
  should be checked once a year.

## Local check without real keys

```sh
pnpm build
FLW_SECRET_KEY=test-only FLW_WEBHOOK_HASH=test FLW_API_BASE=http://127.0.0.1:1 DATA_DIR=/tmp/sl PORT=3999 node dist/src/index.js
curl -s localhost:3999/ship | grep -o 'action="/pay/[a-z]*"'        # buttons post to /pay/<plan>
curl -s -o /dev/null -w '%{http_code}\n' -d email=a@b.co localhost:3999/pay/play   # 502 + error page, no key leaves the box
```
