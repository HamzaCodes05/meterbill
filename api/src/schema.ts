export const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  tax_rate_bps int NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Plans are immutable: to change pricing, create a new plan. Past invoices never move.
CREATE TABLE IF NOT EXISTS plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  base_fee_cents int NOT NULL CHECK (base_fee_cents >= 0),
  seat_fee_cents int NOT NULL DEFAULT 0 CHECK (seat_fee_cents >= 0),
  usage_pricing jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  plan_id uuid NOT NULL REFERENCES plans(id),
  seats int NOT NULL DEFAULT 1 CHECK (seats >= 1),
  started_on date NOT NULL,
  ends_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= started_on)
);
-- at most one open-ended subscription per customer
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_one_open ON subscriptions (customer_id) WHERE ends_on IS NULL;

CREATE TABLE IF NOT EXISTS usage_events (
  id bigserial PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(id),
  metric text NOT NULL,
  quantity bigint NOT NULL CHECK (quantity > 0),
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS usage_events_lookup ON usage_events (customer_id, metric, occurred_at);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'paid')),
  subtotal_cents bigint NOT NULL DEFAULT 0,
  tax_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  finalized_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, period)
);
CREATE INDEX IF NOT EXISTS invoices_customer_period ON invoices (customer_id, period);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id bigserial PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position int NOT NULL,
  kind text NOT NULL,
  description text NOT NULL,
  quantity bigint NOT NULL,
  unit_price text NOT NULL,
  amount_cents bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS invoice_lines_invoice ON invoice_lines (invoice_id, position);
`;
