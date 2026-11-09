# MeterBill: usage-based billing, to the cent

A small billing engine in the spirit of Stripe Billing. Customers subscribe to **plans** (a monthly
fee, a per-seat fee, and metered usage with tiered pricing). Your services report usage
as events, and MeterBill turns it into **accurate, immutable monthly invoices**.

![stack](https://img.shields.io/badge/NestJS-10-red) ![stack](https://img.shields.io/badge/Next.js-14-black) ![stack](https://img.shields.io/badge/PostgreSQL-16-336791) ![ci](https://img.shields.io/badge/CI-GitHub_Actions-2088FF)

Billing is a domain where "close enough" is a bug. The interesting parts of this project are the things
that go wrong quietly: floating-point money, double-counted events, usage that lands after an invoice
is sent, and two requests racing each other.

## How an invoice is built

Example: *Growth* plan, \$99/month base, \$15/seat, API calls free for the first 1,000, \$0.002 up to 10,000,
\$0.001 beyond. Customer has 3 seats, joined on the 17th of a 31-day month, sent 12,445 calls, 8.25% tax.

| Line | Rule | Amount |
|---|---|---|
| Base fee | \$99.00 × 15/31 days (prorated, half-up) | \$47.90 |
| Seats | 3 × \$15.00 × 15/31 days | \$21.77 |
| API calls 1-1,000 | 1,000 × \$0.00 | \$0.00 |
| API calls 1,001-10,000 | 9,000 × \$0.002 | \$18.00 |
| API calls 10,001+ | 2,445 × \$0.001 = 244.5¢ → rounds **up** | \$2.45 |
| Subtotal | sum of the lines above | \$90.12 |
| Tax | 8.25% of subtotal (743.49¢ → 743¢) | \$7.43 |
| **Total** | | **\$97.55** |

Usage is **graduated** (each tier prices only the units inside it) and is **not prorated**. Every line is
rounded half-up to whole cents once, so the total is exactly the sum of the lines the customer sees.

## Design decisions worth reading

- **No floating point, anywhere in the money path.** Amounts are integer cents. Unit prices can be fractions of a cent, so they are `BigInt` **micro-dollars** (`"0.0025"` → `2500n`). `0.1 + 0.2` is exactly `0.3`.
- **Idempotent ingestion.** Events are keyed by `(customer, idempotencyKey)`. Retrying a batch never double counts; reusing a key with a *different* payload is rejected loudly instead of silently ignored.
- **A finalized invoice is a fact.** Finalizing recomputes from the usage that exists at that instant, then locks. Events for a finalized period are rejected (`period_closed`), not silently applied or silently dropped.
- **Ingestion and finalization are serialised per customer** with a Postgres advisory lock, always taken before any row lock, so lock order is consistent and deadlocks are impossible. See the race test below.
- **Drafts are safe to regenerate.** `generate` is idempotent (unique per subscription and period) and refreshes drafts with late usage; it never touches a finalized invoice.
- **Plans are immutable.** To change a price, create a new plan; old invoices can never shift.
- **Invoices are snapshots.** Lines store their own description, quantity and unit price.
- **Bad pricing can't reach an invoice.** Tier definitions are validated on plan creation (ascending, last tier open-ended, parseable prices).
- **Per-event results.** A batch of up to 1,000 returns a result for each event; one bad event never fails the others.
- **The ingest key never reaches a browser.** The dashboard's usage simulator uses a separate admin-JWT endpoint.

## Run it

```bash
cp .env.example .env     # change the secrets
docker compose up --build
```

Open http://localhost:3000 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Create a plan, a customer and a
subscription (start it last month), send usage on the **Usage** tab (the sample burst spans ~6 weeks), then on
**Invoices** pick last month, **Generate drafts**, open one, **Finalize**, and **Mark paid**.

Sending usage from your own services:

```bash
curl -X POST http://localhost:4000/v1/events -H "x-api-key: $INGEST_KEY" -H "content-type: application/json" -d '{
  "events": [{ "customerId": "<uuid>", "metric": "api_calls", "quantity": 250,
               "timestamp": "2026-10-14T09:30:00Z", "idempotencyKey": "req-8f3a" }] }'
```

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /v1/events` | ingest key | Batch (1-1,000) usage ingestion, per-event results |
| `POST /auth/login` | none | Admin login → JWT |
| `GET/POST /v1/customers`, `GET /v1/customers/:id/usage?period=` | JWT | Customers and usage summary |
| `GET/POST /v1/plans` | JWT | Plans (immutable) |
| `GET/POST /v1/subscriptions`, `POST …/:id/cancel` | JWT | Subscriptions (cancel = end of month) |
| `POST /v1/invoices/generate` | JWT | Create/refresh drafts for a period |
| `GET /v1/invoices`, `GET /v1/invoices/:id` | JWT | List / detail with lines |
| `POST /v1/invoices/:id/finalize`, `…/pay` | JWT | Lock the invoice / mark paid (both idempotent) |

## Tests

```bash
cd api && npm test                 # 50 unit tests for the pricing engine (including this README's worked example)
python3 scripts/smoke.py           # 53 end-to-end checks against a running API + Postgres
python3 scripts/race.py            # concurrency stress test (see below)
```

- **Pricing is verified twice.** The unit tests include a 300-case randomized comparison against a naive unit-by-unit reference. The end-to-end test recomputes every expected invoice with a **separate Python implementation**, so the engine is checked against a second implementation rather than against itself. It deliberately lands on exact half-cent boundaries.
- **The race test has teeth.** It floods a customer with events while finalizing its invoice at a random moment mid-flood, and asserts that **units on the invoice = units accepted = units stored**. I verified the test by removing the lock: **12 of 12 trials then lost revenue** (events accepted and stored but never billed). With the lock, all trials hold.

## Known limitations

- Calendar-month billing in UTC; one currency (USD).
- Seats are fixed at subscription time. Mid-cycle seat changes (and their proration) aren't supported.
- Cancellation takes effect at the end of the month, with no credits or refunds.
- Usage that arrives after finalization is rejected. A real system would issue credit notes or adjustment invoices.
- "Pay" just records payment; there is no payment processor.
- Tax is a flat per-customer rate, not jurisdiction-aware.
- One shared admin login.

## Roadmap

- [ ] Mid-cycle seat changes with proration
- [ ] Credit notes and invoice adjustments
- [ ] Stripe (or similar) payment integration with webhooks
- [ ] Multi-currency and jurisdiction-aware tax
- [ ] Invoice PDFs and email delivery
- [ ] Anniversary billing cycles and usage commitments / overage

## License

MIT
