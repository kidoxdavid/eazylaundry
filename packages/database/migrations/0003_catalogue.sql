-- 0003_catalogue: service catalogue, versioned price lists, tax rates.
-- Prices are append-only: a change inserts a new version; orders snapshot what they used, so history never changes.

CREATE TABLE service_categories (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  sort_order int NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX service_categories_name_uq ON service_categories (tenant_id, lower(name)) WHERE archived_at IS NULL;

CREATE TABLE services (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  category_id uuid,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text CHECK (description IS NULL OR length(description) <= 500),
  pricing_model text NOT NULL CHECK (pricing_model IN ('per_kg','per_item','fixed')),
  tax_category text NOT NULL DEFAULT 'taxable' CHECK (tax_category IN ('taxable','zero_rated','exempt')),
  express_capable boolean NOT NULL DEFAULT false,
  turnaround_hours int NOT NULL DEFAULT 48 CHECK (turnaround_hours BETWEEN 1 AND 720),
  requires_garment_tracking boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, category_id) REFERENCES service_categories(tenant_id, id)
);

CREATE TABLE price_lists (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  kind text NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard','contract','customer')),
  is_default boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (NOT is_default OR kind = 'standard')
);
CREATE UNIQUE INDEX price_lists_one_default ON price_lists (tenant_id) WHERE is_default;

-- Each row is a price VERSION. Current price = newest row with valid_from <= now() for (list, service, branch);
-- a branch-specific row overrides the all-branches row (branch_id NULL).
CREATE TABLE service_prices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  price_list_id uuid NOT NULL,
  service_id uuid NOT NULL,
  branch_id uuid,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  min_charge_minor bigint NOT NULL DEFAULT 0 CHECK (min_charge_minor >= 0),
  express_type text NOT NULL DEFAULT 'none' CHECK (express_type IN ('none','percent','fixed')),
  express_percent numeric(7,3) CHECK (express_percent IS NULL OR (express_percent >= 0 AND express_percent <= 500)),
  express_fixed_minor bigint CHECK (express_fixed_minor IS NULL OR express_fixed_minor >= 0),
  valid_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((express_type = 'none' AND express_percent IS NULL AND express_fixed_minor IS NULL)
      OR (express_type = 'percent' AND express_percent IS NOT NULL AND express_fixed_minor IS NULL)
      OR (express_type = 'fixed' AND express_fixed_minor IS NOT NULL AND express_percent IS NULL)),
  FOREIGN KEY (tenant_id, price_list_id) REFERENCES price_lists(tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES services(tenant_id, id),
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id)
);
CREATE INDEX service_prices_lookup ON service_prices (tenant_id, price_list_id, service_id, branch_id, valid_from DESC);
CREATE TRIGGER service_prices_append_only BEFORE UPDATE OR DELETE ON service_prices
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

-- Effective-dated tax components. Defaults are seeded per tenant at registration (Alberta: GST 5%), never hardcoded in logic.
CREATE TABLE tax_rates (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,10}$'),
  name text NOT NULL,
  rate numeric(9,6) NOT NULL CHECK (rate >= 0 AND rate <= 1),
  compound boolean NOT NULL DEFAULT false,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX tax_rates_active ON tax_rates (tenant_id, effective_from);

SELECT eazy_tenant_rls('service_categories', 'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('services',           'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('price_lists',        'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('service_prices',     'SELECT, INSERT');
SELECT eazy_tenant_rls('tax_rates',          'SELECT, INSERT, UPDATE');
