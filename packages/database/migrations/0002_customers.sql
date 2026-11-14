-- 0002_customers: tenant-scoped customer records, addresses, consent history.
-- Customers belong to exactly one tenant (a person using two laundries has two records).

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL DEFAULT 'individual' CHECK (kind IN ('individual','guest','commercial_contact')),
  full_name text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  email citext CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text CHECK (phone IS NULL OR phone ~ '^\+[0-9]{8,15}$'),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  preferences jsonb NOT NULL DEFAULT '{}',
  created_by uuid,
  version int NOT NULL DEFAULT 1,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
-- Duplicate prevention among live records only (an archived customer frees the contact detail).
CREATE UNIQUE INDEX customers_email_uq ON customers (tenant_id, email) WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX customers_phone_uq ON customers (tenant_id, phone) WHERE phone IS NOT NULL AND archived_at IS NULL;
CREATE INDEX customers_name_trgm ON customers USING gin (full_name gin_trgm_ops);
CREATE INDEX customers_tenant_name_idx ON customers (tenant_id, lower(full_name), id);

CREATE TABLE customer_addresses (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  label text NOT NULL DEFAULT 'Home',
  line1 text NOT NULL,
  line2 text,
  city text NOT NULL,
  province char(2) NOT NULL CHECK (province IN ('AB','BC','MB','NB','NL','NS','NT','NU','ON','PE','QC','SK','YT')),
  postal_code text NOT NULL CHECK (postal_code ~ '^[ABCEGHJ-NPRSTVXY][0-9][ABCEGHJ-NPRSTV-Z] [0-9][ABCEGHJ-NPRSTV-Z][0-9]$'),
  country char(2) NOT NULL DEFAULT 'CA',
  delivery_instructions text CHECK (delivery_instructions IS NULL OR length(delivery_instructions) <= 500),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX customer_addresses_one_default ON customer_addresses (customer_id) WHERE is_default;
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (tenant_id, customer_id);

-- Append-only consent ledger; the effective state is the latest row per (customer, purpose).
CREATE TABLE customer_consents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('marketing_email','marketing_sms','transactional_sms')),
  granted boolean NOT NULL,
  source text NOT NULL CHECK (source IN ('pos','portal','storefront','import','staff','unsubscribe_link')),
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX customer_consents_latest_idx ON customer_consents (tenant_id, customer_id, purpose, recorded_at DESC);
CREATE TRIGGER customer_consents_append_only BEFORE UPDATE ON customer_consents
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

SELECT eazy_tenant_rls('customers',          'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('customer_addresses', 'SELECT, INSERT, UPDATE, DELETE');
SELECT eazy_tenant_rls('customer_consents',  'SELECT, INSERT');
