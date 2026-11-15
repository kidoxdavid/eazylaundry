-- 0009_saas_platform: subscription plans + entitlements, tenant subscriptions and overrides, and the PLATFORM realm
-- (Eazy Group's SaaS operations). The platform role sees tenant metadata and usage COUNTS only (column-level grants),
-- never customers, orders' contents, prices or anything else a business owns.

-- ===== Plans (global reference data; pricing below is a starting HYPOTHESIS, editable in the platform console) =====
CREATE TABLE subscription_plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  billing_interval text NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month','year')),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),   -- NULL = custom pricing (Enterprise)
  currency char(3) NOT NULL DEFAULT 'CAD',
  is_public boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE plan_entitlements (
  plan_id uuid NOT NULL REFERENCES subscription_plans(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^(limit|module|feature)\.[a-z_]+$'),
  value jsonb NOT NULL,      -- limit.*: integer or null (unlimited); module.*: boolean; feature.*: string/boolean
  PRIMARY KEY (plan_id, key)
);

WITH p AS (
  INSERT INTO subscription_plans (id, code, name, price_minor, sort_order) VALUES
    (gen_random_uuid(), 'starter',      'Starter',       4900, 1),
    (gen_random_uuid(), 'professional', 'Professional',  9900, 2),
    (gen_random_uuid(), 'business',     'Business',     17900, 3),
    (gen_random_uuid(), 'enterprise',   'Enterprise',    NULL, 4)
  RETURNING id, code
)
INSERT INTO plan_entitlements (plan_id, key, value)
SELECT p.id, e.key, e.value FROM p JOIN (VALUES
  ('starter','limit.branches','1'::jsonb), ('starter','limit.staff_seats','5'), ('starter','module.delivery','false'), ('starter','module.storefront','true'), ('starter','module.commercial','false'), ('starter','feature.reports','"basic"'),
  ('professional','limit.branches','2'), ('professional','limit.staff_seats','15'), ('professional','module.delivery','true'), ('professional','module.storefront','true'), ('professional','module.commercial','false'), ('professional','feature.reports','"standard"'),
  ('business','limit.branches','5'), ('business','limit.staff_seats','40'), ('business','module.delivery','true'), ('business','module.storefront','true'), ('business','module.commercial','true'), ('business','feature.reports','"advanced"'),
  ('enterprise','limit.branches','null'), ('enterprise','limit.staff_seats','null'), ('enterprise','module.delivery','true'), ('enterprise','module.storefront','true'), ('enterprise','module.commercial','true'), ('enterprise','feature.reports','"custom"')
) AS e(code, key, value) ON e.code = p.code;

GRANT SELECT ON subscription_plans, plan_entitlements TO eazy_app;        -- tenants may read the plan catalogue
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_plans, plan_entitlements TO eazy_platform;

-- ===== Per-tenant subscription + overrides (tenant-scoped; the tenant can read, only the platform can change) =====
CREATE TABLE subscriptions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  plan_id uuid NOT NULL REFERENCES subscription_plans(id),
  trial_ends_at timestamptz,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  past_due_since timestamptz,
  status_reason text CHECK (status_reason IS NULL OR length(status_reason) <= 300),
  billing_provider text NOT NULL DEFAULT 'manual' CHECK (billing_provider IN ('manual','stripe')),
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE tenant_entitlement_overrides (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL CHECK (key ~ '^(limit|module|feature)\.[a-z_]+$'),
  value jsonb NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  expires_at timestamptz,
  set_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);
SELECT eazy_tenant_rls('subscriptions', 'SELECT, INSERT');                    -- INSERT only so registration/first-use can create the trial
SELECT eazy_tenant_rls('tenant_entitlement_overrides', 'SELECT');
CREATE POLICY platform_all ON subscriptions TO eazy_platform USING (true) WITH CHECK (true);
CREATE POLICY platform_all ON tenant_entitlement_overrides TO eazy_platform USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON subscriptions TO eazy_platform;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_entitlement_overrides TO eazy_platform;

-- ===== What the platform may see of tenants: metadata and counts only =====
CREATE POLICY platform_all ON tenants TO eazy_platform USING (true) WITH CHECK (true);
GRANT SELECT (id, slug, name, status, is_demo, created_at), UPDATE (status) ON tenants TO eazy_platform;
CREATE POLICY platform_read ON branches FOR SELECT TO eazy_platform USING (true);
GRANT SELECT (id, tenant_id, status) ON branches TO eazy_platform;
CREATE POLICY platform_read ON user_memberships FOR SELECT TO eazy_platform USING (true);
GRANT SELECT (id, tenant_id, status) ON user_memberships TO eazy_platform;
CREATE POLICY platform_read ON orders FOR SELECT TO eazy_platform USING (true);
GRANT SELECT (id, tenant_id, created_at) ON orders TO eazy_platform;
-- Orders carry a RESTRICTIVE branch policy that applies to every role; let the platform role count orders (and nothing else) past it.
DROP POLICY branch_scope ON orders;
CREATE POLICY branch_scope ON orders AS RESTRICTIVE
  USING (app_all_branches() OR branch_id = ANY (app_branch_ids()) OR current_user = 'eazy_platform')
  WITH CHECK (app_all_branches() OR branch_id = ANY (app_branch_ids()));

-- ===== Platform realm: its own users, sessions and audit trail (unreachable by the tenant-facing application role) =====
CREATE TABLE platform_users (
  id uuid PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('platform_admin','billing_ops','support_agent')),
  mfa_secret text NOT NULL,                       -- MFA is mandatory for every platform user (encrypted TOTP seed)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES platform_users(id),
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE TABLE platform_audit_logs (
  id uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL,
  action text NOT NULL,
  target_tenant_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  ip inet,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_time_idx ON platform_audit_logs (occurred_at DESC);
CREATE TRIGGER platform_audit_append_only BEFORE UPDATE OR DELETE ON platform_audit_logs
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();
GRANT SELECT, INSERT, UPDATE ON platform_users, platform_sessions TO eazy_platform;
GRANT SELECT, INSERT ON platform_audit_logs TO eazy_platform;
