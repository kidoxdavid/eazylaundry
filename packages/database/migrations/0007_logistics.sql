-- 0007_logistics: delivery zones (postal-prefix based), pickup/delivery tasks, task events, order delivery-fee columns.
-- Zones are matched by Canadian postal prefix (FSA or longer). Distance/polygon zones need a maps provider and are not built.

CREATE TABLE delivery_zones (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  postal_prefixes text[] NOT NULL CHECK (cardinality(postal_prefixes) BETWEEN 1 AND 200),
  min_order_minor bigint NOT NULL DEFAULT 0 CHECK (min_order_minor >= 0),
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  free_over_minor bigint CHECK (free_over_minor IS NULL OR free_over_minor > 0),
  taxable boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX delivery_zones_name_uq ON delivery_zones (tenant_id, lower(name));

ALTER TABLE orders
  ADD COLUMN delivery_fee_minor bigint NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
  ADD COLUMN delivery_fee_tax_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN delivery_fee_tax_breakdown jsonb NOT NULL DEFAULT '{}';

CREATE TABLE delivery_tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('pickup','delivery')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','assigned','en_route','completed','failed','cancelled')),
  order_id uuid,
  customer_id uuid NOT NULL,
  zone_id uuid,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  address jsonb NOT NULL,
  postal_code text NOT NULL,
  contact_name text NOT NULL,
  contact_phone text,
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  fee_minor bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  assigned_to uuid,
  assigned_at timestamptz,
  attempts int NOT NULL DEFAULT 0,
  otp_enc text,
  otp_attempts int NOT NULL DEFAULT 0,
  bag_count int CHECK (bag_count IS NULL OR bag_count BETWEEN 1 AND 100),
  proof jsonb,
  failure_reason text CHECK (failure_reason IS NULL OR failure_reason IN ('no_answer','wrong_address','refused','not_home','other')),
  created_by uuid NOT NULL,
  completed_at timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (window_end > window_start),
  CHECK (kind = 'pickup' OR order_id IS NOT NULL),
  CHECK (status NOT IN ('assigned','en_route') OR assigned_to IS NOT NULL),
  CHECK (status <> 'completed' OR completed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, zone_id) REFERENCES delivery_zones(tenant_id, id)
);
CREATE INDEX delivery_tasks_board_idx ON delivery_tasks (tenant_id, branch_id, status, window_start);
CREATE INDEX delivery_tasks_driver_idx ON delivery_tasks (tenant_id, assigned_to, window_start) WHERE assigned_to IS NOT NULL;
CREATE INDEX delivery_tasks_order_idx ON delivery_tasks (tenant_id, order_id) WHERE order_id IS NOT NULL;
-- One live delivery per order (a failed or cancelled attempt can be replaced).
CREATE UNIQUE INDEX delivery_tasks_one_live_delivery ON delivery_tasks (tenant_id, order_id) WHERE kind = 'delivery' AND status NOT IN ('cancelled','failed');

CREATE TABLE delivery_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  task_id uuid NOT NULL,
  type text NOT NULL,
  actor_user_id uuid,
  note text,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, task_id) REFERENCES delivery_tasks(tenant_id, id)
);
CREATE INDEX delivery_events_task_idx ON delivery_events (tenant_id, task_id, occurred_at);
CREATE TRIGGER delivery_events_append_only BEFORE UPDATE OR DELETE ON delivery_events
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

SELECT eazy_tenant_rls('delivery_zones',  'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('delivery_tasks',  'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('delivery_events', 'SELECT, INSERT');
SELECT eazy_branch_rls('delivery_tasks');
SELECT eazy_branch_rls('delivery_events');
