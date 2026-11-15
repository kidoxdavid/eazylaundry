-- 0008_portal_notifications: customer accounts/sessions (a separate login realm from staff), database-level customer scoping,
-- public storefront lookup by slug, and the notifications queue with a least-privilege worker role.

-- ===== Customer scope: when a customer session sets app.customer_id, ONLY that customer's rows are visible/writable. =====
CREATE FUNCTION app_customer() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.customer_id', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION app_customer() TO eazy_app;

CREATE POLICY customer_scope ON orders AS RESTRICTIVE USING (app_customer() IS NULL OR customer_id = app_customer());
CREATE POLICY customer_scope ON delivery_tasks AS RESTRICTIVE USING (app_customer() IS NULL OR customer_id = app_customer());
CREATE POLICY customer_scope ON customers AS RESTRICTIVE USING (app_customer() IS NULL OR id = app_customer());
CREATE POLICY customer_scope ON customer_addresses AS RESTRICTIVE USING (app_customer() IS NULL OR customer_id = app_customer());
CREATE POLICY customer_scope ON customer_consents AS RESTRICTIVE USING (app_customer() IS NULL OR customer_id = app_customer());
-- Child tables have no customer column: they are visible only through an order the customer can already see.
CREATE POLICY customer_scope ON order_lines AS RESTRICTIVE USING (app_customer() IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = order_lines.tenant_id AND o.id = order_lines.order_id));
CREATE POLICY customer_scope ON order_events AS RESTRICTIVE USING (app_customer() IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = order_events.tenant_id AND o.id = order_events.order_id));
CREATE POLICY customer_scope ON payment_allocations AS RESTRICTIVE USING (app_customer() IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = payment_allocations.tenant_id AND o.id = payment_allocations.order_id));
CREATE POLICY customer_scope ON payments AS RESTRICTIVE USING (app_customer() IS NULL OR EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.tenant_id = payments.tenant_id AND pa.payment_id = payments.id));
CREATE POLICY customer_scope ON delivery_events AS RESTRICTIVE USING (app_customer() IS NULL OR EXISTS (SELECT 1 FROM delivery_tasks t WHERE t.tenant_id = delivery_events.tenant_id AND t.id = delivery_events.task_id));
CREATE POLICY customer_scope ON refunds AS RESTRICTIVE USING (app_customer() IS NULL OR EXISTS (SELECT 1 FROM orders o WHERE o.tenant_id = refunds.tenant_id AND o.id = refunds.order_id));

-- ===== Public storefront: a tenant row is readable by anyone who names its slug (set as a transaction-local setting). =====
CREATE POLICY public_slug_lookup ON tenants FOR SELECT USING (slug = nullif(current_setting('app.public_slug', true), ''));

-- ===== Customer accounts =====
CREATE TABLE customer_accounts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid NOT NULL,
  email citext NOT NULL CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disabled')),
  email_verified_at timestamptz,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email),
  UNIQUE (tenant_id, customer_id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)
);

CREATE TABLE customer_tokens (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  account_id uuid NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('verify_email','reset_password')),
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id)
);

CREATE FUNCTION app_session_hash() RETURNS bytea LANGUAGE sql STABLE AS
  $$ SELECT decode(nullif(current_setting('app.session_hash', true), ''), 'hex') $$;
GRANT EXECUTE ON FUNCTION app_session_hash() TO eazy_app;

-- Sessions are looked up by token hash BEFORE the tenant is known. RLS lets a caller see only the row whose hash it presents
-- (or rows of the active tenant), so even a bug cannot enumerate other sessions.
CREATE TABLE customer_sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  account_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (tenant_id, account_id) REFERENCES customer_accounts(tenant_id, id)
);
CREATE INDEX customer_sessions_account_idx ON customer_sessions (account_id);
ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY session_access ON customer_sessions
  USING (tenant_id = app_tenant() OR token_hash = app_session_hash()) WITH CHECK (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON customer_sessions TO eazy_app;

SELECT eazy_tenant_rls('customer_accounts', 'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('customer_tokens',   'SELECT, INSERT, UPDATE');

-- ===== Notifications (outbox + delivery log) =====
CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  customer_id uuid,
  order_id uuid,
  task_id uuid,
  channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email')),
  template text NOT NULL,
  to_address text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  sensitive boolean NOT NULL DEFAULT false,
  -- queued -> sending -> sent | failed ; 'logged' = no provider configured (NOT delivered) ; 'suppressed' = deliberately not sent
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','logged','suppressed')),
  provider text,
  provider_ref text,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX notifications_dedupe_uq ON notifications (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE status = 'queued';
CREATE INDEX notifications_order_idx ON notifications (tenant_id, order_id) WHERE order_id IS NOT NULL;

SELECT eazy_tenant_rls('notifications', 'SELECT, INSERT');
-- The worker has no tenant context: it may only read and progress notification rows, nothing else in the database.
GRANT SELECT, UPDATE ON notifications TO eazy_worker;
CREATE POLICY worker_all ON notifications TO eazy_worker USING (true) WITH CHECK (true);
