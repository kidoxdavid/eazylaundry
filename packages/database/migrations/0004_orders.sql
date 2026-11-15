-- 0004_orders: orders, immutable order lines (price snapshots), append-only events, payments + allocations.
-- Branch-owned tables also get the RESTRICTIVE branch_scope policy, so branch-limited staff are isolated by the database itself.

ALTER TABLE service_prices ADD CONSTRAINT service_prices_tenant_id_id_key UNIQUE (tenant_id, id);

-- Gap-free per-branch, per-month counters. UPSERT row-locks, so concurrent order creation serialises on this row.
CREATE TABLE order_counters (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  period text NOT NULL CHECK (period ~ '^[0-9]{4}$'),
  last_value int NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, branch_id, period),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  branch_id uuid NOT NULL,
  order_no text NOT NULL,
  customer_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ready','completed','cancelled')),
  source text NOT NULL DEFAULT 'pos' CHECK (source IN ('pos','portal','storefront','recurring','api')),
  express boolean NOT NULL DEFAULT false,
  currency char(3) NOT NULL,
  price_mode text NOT NULL CHECK (price_mode IN ('exclusive','inclusive')),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  net_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  paid_minor bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0),
  instructions text CHECK (instructions IS NULL OR length(instructions) <= 1000),
  promised_at timestamptz NOT NULL,
  cancelled_reason text,
  created_by uuid NOT NULL,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, order_no),
  CHECK (paid_minor <= total_minor),
  CHECK (net_minor + tax_minor = total_minor),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);
CREATE INDEX orders_branch_status_idx ON orders (tenant_id, branch_id, status, promised_at);
CREATE INDEX orders_customer_idx ON orders (tenant_id, customer_id, created_at DESC);
CREATE INDEX orders_created_idx ON orders (tenant_id, created_at DESC);

-- Lines are an immutable snapshot of exactly what was quoted. Later price/config changes never touch them.
CREATE TABLE order_lines (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  line_no int NOT NULL,
  service_id uuid NOT NULL,
  price_id uuid NOT NULL,
  service_code text NOT NULL,
  service_name text NOT NULL,
  pricing_model text NOT NULL,
  quantity int,
  weight_g int,
  unit_price_minor bigint NOT NULL,
  base_minor bigint NOT NULL,
  min_charge_applied boolean NOT NULL DEFAULT false,
  express_minor bigint NOT NULL DEFAULT 0,
  discount_minor bigint NOT NULL DEFAULT 0,
  net_minor bigint NOT NULL,
  tax_minor bigint NOT NULL,
  total_minor bigint NOT NULL,
  tax_breakdown jsonb NOT NULL DEFAULT '{}',
  turnaround_hours int NOT NULL,
  UNIQUE (order_id, line_no),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id),
  FOREIGN KEY (tenant_id, price_id) REFERENCES service_prices(tenant_id, id)
);
CREATE TRIGGER order_lines_append_only BEFORE UPDATE OR DELETE ON order_lines
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

CREATE TABLE order_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  type text NOT NULL,
  actor_user_id uuid,
  note text,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);
CREATE INDEX order_events_order_idx ON order_events (tenant_id, order_id, occurred_at);
CREATE TRIGGER order_events_append_only BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

-- A payment is money that arrived; allocations say which order it settled (one payment may later span several).
CREATE TABLE payments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','card_external','e_transfer','other')),
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  tendered_minor bigint CHECK (tendered_minor IS NULL OR tendered_minor >= amount_minor),
  change_minor bigint NOT NULL DEFAULT 0 CHECK (change_minor >= 0),
  currency char(3) NOT NULL,
  reference text CHECK (reference IS NULL OR length(reference) <= 100),
  received_by uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  CHECK (tendered_minor IS NULL OR change_minor = tendered_minor - amount_minor)
);
CREATE INDEX payments_branch_time_idx ON payments (tenant_id, branch_id, received_at DESC);
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  order_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);
CREATE INDEX payment_allocations_order_idx ON payment_allocations (tenant_id, order_id);
CREATE TRIGGER payment_allocations_append_only BEFORE UPDATE OR DELETE ON payment_allocations
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

SELECT eazy_tenant_rls('order_counters',       'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('orders',               'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('order_lines',          'SELECT, INSERT');
SELECT eazy_tenant_rls('order_events',         'SELECT, INSERT');
SELECT eazy_tenant_rls('payments',             'SELECT, INSERT');
SELECT eazy_tenant_rls('payment_allocations',  'SELECT, INSERT');

SELECT eazy_branch_rls('order_counters');
SELECT eazy_branch_rls('orders');
SELECT eazy_branch_rls('order_lines');
SELECT eazy_branch_rls('order_events');
SELECT eazy_branch_rls('payments');
SELECT eazy_branch_rls('payment_allocations');
