-- 0005_production: configurable workflow stages, order stage tracking, scan tokens, quality inspections.
-- Stages are DATA (per tenant, editable later); an order pins the workflow definition it started with.

CREATE TABLE workflow_definitions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  is_default boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX workflow_one_default ON workflow_definitions (tenant_id) WHERE is_default;

CREATE TABLE workflow_stages (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  sequence int NOT NULL CHECK (sequence >= 1),
  -- Permission needed to COMPLETE this stage, i.e. to move the order on from it.
  required_permission text NOT NULL REFERENCES permissions(code),
  expected_minutes int NOT NULL DEFAULT 0 CHECK (expected_minutes BETWEEN 0 AND 10080),
  optional boolean NOT NULL DEFAULT false,
  is_qc boolean NOT NULL DEFAULT false,
  is_terminal boolean NOT NULL DEFAULT false,
  order_status text NOT NULL DEFAULT 'open' CHECK (order_status IN ('open','ready','completed')),
  UNIQUE (tenant_id, id),
  UNIQUE (definition_id, key),
  UNIQUE (definition_id, sequence),
  FOREIGN KEY (tenant_id, definition_id) REFERENCES workflow_definitions(tenant_id, id)
);

ALTER TABLE orders
  ADD COLUMN workflow_definition_id uuid,
  ADD COLUMN current_stage_id uuid,
  ADD COLUMN stage_entered_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN rework_count int NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
  ADD COLUMN scan_token text,
  ADD CONSTRAINT orders_scan_token_format CHECK (scan_token IS NULL OR scan_token ~ '^[0-9A-HJKMNP-TV-Z]{10}$'),
  ADD CONSTRAINT orders_stage_fk FOREIGN KEY (tenant_id, current_stage_id) REFERENCES workflow_stages(tenant_id, id),
  ADD CONSTRAINT orders_workflow_fk FOREIGN KEY (tenant_id, workflow_definition_id) REFERENCES workflow_definitions(tenant_id, id);
-- Scan tokens are globally unique so a printed label can never resolve to the wrong business.
CREATE UNIQUE INDEX orders_scan_token_uq ON orders (scan_token) WHERE scan_token IS NOT NULL;
CREATE INDEX orders_stage_idx ON orders (tenant_id, branch_id, current_stage_id) WHERE status IN ('open','ready');

CREATE TABLE quality_inspections (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  order_id uuid NOT NULL,
  stage_id uuid NOT NULL,
  result text NOT NULL CHECK (result IN ('pass','fail')),
  reason_code text CHECK (reason_code IN ('stain_remains','odour','wrinkles','fold_issue','damage','missing_item','other')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  rework_stage_id uuid,
  inspector_user_id uuid NOT NULL,
  inspected_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((result = 'pass' AND reason_code IS NULL AND rework_stage_id IS NULL) OR (result = 'fail' AND reason_code IS NOT NULL AND rework_stage_id IS NOT NULL)),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES workflow_stages(tenant_id, id),
  FOREIGN KEY (tenant_id, rework_stage_id) REFERENCES workflow_stages(tenant_id, id)
);
CREATE INDEX quality_inspections_order_idx ON quality_inspections (tenant_id, order_id, inspected_at);
CREATE TRIGGER quality_inspections_append_only BEFORE UPDATE OR DELETE ON quality_inspections
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

SELECT eazy_tenant_rls('workflow_definitions', 'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('workflow_stages',      'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('quality_inspections',  'SELECT, INSERT');
SELECT eazy_branch_rls('quality_inspections');

-- Resolving a scanned label happens BEFORE the tenant is known to the caller's request, but the scanner is always an
-- authenticated member, so the lookup still runs under RLS in their own tenant context (no cross-tenant function needed).
