-- 0006_cash_refunds: cash drawer shifts, pay-in/out movements, refund requests (approval workflow) and refunds.
-- Refunds are always linked to the original payment and can never exceed it in total.

CREATE TABLE cash_shifts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  opened_by uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  opening_float_minor bigint NOT NULL CHECK (opening_float_minor >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_by uuid,
  closed_at timestamptz,
  expected_cash_minor bigint,
  counted_cash_minor bigint CHECK (counted_cash_minor IS NULL OR counted_cash_minor >= 0),
  variance_minor bigint,
  close_note text CHECK (close_note IS NULL OR length(close_note) <= 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  CHECK ((status = 'open' AND closed_at IS NULL AND counted_cash_minor IS NULL)
      OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND counted_cash_minor IS NOT NULL
          AND expected_cash_minor IS NOT NULL AND variance_minor = counted_cash_minor - expected_cash_minor))
);
-- A person can run one open till per branch at a time.
CREATE UNIQUE INDEX cash_shifts_one_open ON cash_shifts (tenant_id, branch_id, opened_by) WHERE status = 'open';
CREATE INDEX cash_shifts_branch_idx ON cash_shifts (tenant_id, branch_id, opened_at DESC);

CREATE TABLE cash_movements (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('pay_in','pay_out')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 200),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cash_shifts(tenant_id, id)
);
CREATE TRIGGER cash_movements_append_only BEFORE UPDATE OR DELETE ON cash_movements
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

-- Cash payments are tied to the till they went into (payments stay append-only, so this is set at insert).
ALTER TABLE payments ADD COLUMN shift_id uuid,
  ADD CONSTRAINT payments_shift_fk FOREIGN KEY (tenant_id, shift_id) REFERENCES cash_shifts(tenant_id, id),
  ADD CONSTRAINT payments_shift_cash_only CHECK (shift_id IS NULL OR method = 'cash');
CREATE INDEX payments_shift_idx ON payments (tenant_id, shift_id) WHERE shift_id IS NOT NULL;

CREATE TABLE refund_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  completed_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK (status = 'pending' OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id)
);
CREATE INDEX refund_requests_status_idx ON refund_requests (tenant_id, branch_id, status, requested_at);

CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  request_id uuid NOT NULL,
  order_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('cash','card_external','e_transfer','other')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency char(3) NOT NULL,
  reference text CHECK (reference IS NULL OR length(reference) <= 100),
  shift_id uuid,
  refunded_by uuid NOT NULL,
  refunded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_id),
  CHECK (shift_id IS NULL OR method = 'cash'),
  FOREIGN KEY (tenant_id, request_id) REFERENCES refund_requests(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payments(tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cash_shifts(tenant_id, id)
);
CREATE INDEX refunds_payment_idx ON refunds (tenant_id, payment_id);
CREATE INDEX refunds_shift_idx ON refunds (tenant_id, shift_id) WHERE shift_id IS NOT NULL;
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

SELECT eazy_tenant_rls('cash_shifts',      'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('cash_movements',   'SELECT, INSERT');
SELECT eazy_tenant_rls('refund_requests',  'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('refunds',          'SELECT, INSERT');
SELECT eazy_branch_rls('cash_shifts');
SELECT eazy_branch_rls('cash_movements');
SELECT eazy_branch_rls('refund_requests');
SELECT eazy_branch_rls('refunds');
