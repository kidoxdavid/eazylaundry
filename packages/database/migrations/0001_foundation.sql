-- 0001_foundation: tenancy, identity, RBAC, audit, config, outbox, idempotency + RLS framework.
-- Runs as eazy_owner. The API connects as eazy_app (NOBYPASSRLS, not an owner).

-- ===== Context helpers (return NULL when context is absent => policies fail closed) =====
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app_all_branches() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.all_branches', true), '') = 'true' $$;
CREATE FUNCTION app_branch_ids() RETURNS uuid[] LANGUAGE sql STABLE AS
  $$ SELECT CASE WHEN coalesce(current_setting('app.branch_ids', true), '') = '' THEN ARRAY[]::uuid[]
                 ELSE string_to_array(current_setting('app.branch_ids', true), ',')::uuid[] END $$;

-- Append-only guard (applies to the table owner too).
CREATE FUNCTION eazy_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS
  $$ BEGIN RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation'; END $$;

-- Standard tenant isolation for a table with tenant_id. grants: e.g. 'SELECT, INSERT, UPDATE, DELETE'.
CREATE FUNCTION eazy_tenant_rls(tbl regclass, grants text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY tenant_isolation ON %s USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant())', tbl);
  EXECUTE format('GRANT %s ON %s TO eazy_app', grants, tbl);
END $$;

-- Branch scoping as an additional RESTRICTIVE policy for branch-owned tables (used from Phase 2).
CREATE FUNCTION eazy_branch_rls(tbl regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE POLICY branch_scope ON %s AS RESTRICTIVE USING (app_all_branches() OR branch_id = ANY (app_branch_ids())) WITH CHECK (app_all_branches() OR branch_id = ANY (app_branch_ids()))', tbl);
END $$;

-- ===== Platform / tenancy =====
CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','suspended','cancelled','offboarding')),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Global identity (no tenant_id). Reachable only through own row / tenant membership, or SECURITY DEFINER auth functions.
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret text,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permissions (
  code text PRIMARY KEY,
  description text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false
);
GRANT SELECT ON permissions TO eazy_app;

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
  legal_name text NOT NULL,
  country char(2) NOT NULL DEFAULT 'CA',
  currency char(3) NOT NULL DEFAULT 'CAD',
  locale text NOT NULL DEFAULT 'en-CA',
  timezone text NOT NULL DEFAULT 'America/Edmonton',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE branches (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9]{2,8}$'),
  name text NOT NULL,
  address jsonb NOT NULL DEFAULT '{}',
  timezone text NOT NULL DEFAULT 'America/Edmonton',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code)
);

-- ===== RBAC =====
CREATE TABLE roles (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL,
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, key)
);

CREATE TABLE role_permissions (
  tenant_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission_code text NOT NULL REFERENCES permissions(code),
  max_amount_minor bigint CHECK (max_amount_minor IS NULL OR max_amount_minor >= 0),
  PRIMARY KEY (role_id, permission_code),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE user_memberships (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  all_branches boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id)
);

CREATE TABLE membership_branches (
  tenant_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  PRIMARY KEY (membership_id, branch_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES user_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, branch_id) REFERENCES branches(tenant_id, id) ON DELETE CASCADE
);

-- Opaque server-side sessions; only a hash of the token is stored.
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id),
  active_tenant_id uuid REFERENCES tenants(id),
  mfa_verified boolean NOT NULL DEFAULT false,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
GRANT SELECT, INSERT, UPDATE ON sessions TO eazy_app;

-- ===== Governance / infrastructure =====
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid,
  actor_membership_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  branch_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  ip inet,
  request_id text,
  via_support_grant_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_time_idx ON audit_logs(tenant_id, occurred_at DESC);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

-- Versioned configuration: scope = tenant|branch. Resolution: branch > tenant > code default.
CREATE TABLE config_entries (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL CHECK (scope IN ('tenant','branch')),
  scope_id uuid NOT NULL,
  key text NOT NULL,
  version int NOT NULL,
  value jsonb NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, scope, scope_id, key, version)
);
CREATE TRIGGER config_entries_append_only BEFORE UPDATE OR DELETE ON config_entries
  FOR EACH ROW EXECUTE FUNCTION eazy_deny_mutation();

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events(created_at) WHERE processed_at IS NULL;

CREATE TABLE idempotency_keys (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, scope, key)
);

-- ===== Row-Level Security =====
SELECT eazy_tenant_rls('organizations',     'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('branches',          'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('roles',             'SELECT, INSERT, UPDATE, DELETE');
SELECT eazy_tenant_rls('role_permissions',  'SELECT, INSERT, UPDATE, DELETE');
SELECT eazy_tenant_rls('membership_branches','SELECT, INSERT, DELETE');
SELECT eazy_tenant_rls('audit_logs',        'SELECT, INSERT');
SELECT eazy_tenant_rls('config_entries',    'SELECT, INSERT');
SELECT eazy_tenant_rls('outbox_events',     'SELECT, INSERT, UPDATE');
SELECT eazy_tenant_rls('idempotency_keys',  'SELECT, INSERT, UPDATE');

-- user_memberships: a user may see THEIR OWN memberships across tenants (needed to log in / switch);
-- writes are strictly within the active tenant.
ALTER TABLE user_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY read_own_or_tenant ON user_memberships FOR SELECT
  USING (tenant_id = app_tenant() OR user_id = app_user());
CREATE POLICY write_tenant ON user_memberships FOR INSERT WITH CHECK (tenant_id = app_tenant());
CREATE POLICY update_tenant ON user_memberships FOR UPDATE
  USING (tenant_id = app_tenant()) WITH CHECK (tenant_id = app_tenant());
CREATE POLICY delete_tenant ON user_memberships FOR DELETE USING (tenant_id = app_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON user_memberships TO eazy_app;

-- tenants: visible when active, or when the current user is a member.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants FOR SELECT
  USING (id = app_tenant() OR id IN (SELECT tenant_id FROM user_memberships WHERE user_id = app_user()));
CREATE POLICY tenant_create ON tenants FOR INSERT WITH CHECK (id = app_tenant());
CREATE POLICY tenant_update ON tenants FOR UPDATE USING (id = app_tenant()) WITH CHECK (id = app_tenant());
GRANT SELECT, INSERT, UPDATE ON tenants TO eazy_app;

-- users: own row, or members of the active tenant. Not FORCEd so SECURITY DEFINER auth functions (owned by the
-- table owner) can operate; eazy_app itself is always subject to the policy.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_visible ON users FOR SELECT
  USING (id = app_user()
         OR id IN (SELECT user_id FROM user_memberships WHERE tenant_id = app_tenant()));
CREATE POLICY user_update_self ON users FOR UPDATE USING (id = app_user()) WITH CHECK (id = app_user());
GRANT SELECT, UPDATE ON users TO eazy_app;

-- ===== Narrow SECURITY DEFINER auth primitives (the only way eazy_app creates/looks up users) =====
CREATE FUNCTION auth_find_user(p_email citext)
RETURNS TABLE (id uuid, password_hash text, status text, mfa_enabled boolean, mfa_secret text,
               failed_attempts int, locked_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS
  $$ SELECT u.id, u.password_hash, u.status, u.mfa_enabled, u.mfa_secret, u.failed_attempts, u.locked_until
       FROM users u WHERE u.email = p_email $$;

-- Creates the user if the email is new; an existing user is returned untouched (never overwrites credentials).
CREATE FUNCTION auth_ensure_user(p_id uuid, p_email citext, p_hash text, p_name text, p_must_change boolean)
RETURNS TABLE (id uuid, created boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO users (id, email, password_hash, full_name, must_change_password) VALUES (p_id, p_email, p_hash, p_name, p_must_change)
    ON CONFLICT (email) DO NOTHING;
  SELECT u.id INTO v_id FROM users u WHERE u.email = p_email;
  RETURN QUERY SELECT v_id, (v_id = p_id);
END $$;

CREATE FUNCTION auth_record_login(p_user uuid, p_success boolean, p_max_attempts int, p_lock_minutes int)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_success THEN
    UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = p_user;
  ELSE
    UPDATE users SET failed_attempts = failed_attempts + 1,
      locked_until = CASE WHEN failed_attempts + 1 >= p_max_attempts
                          THEN now() + make_interval(mins => p_lock_minutes) ELSE locked_until END
    WHERE id = p_user;
  END IF;
END $$;

REVOKE ALL ON FUNCTION auth_find_user(citext), auth_ensure_user(uuid, citext, text, text, boolean),
  auth_record_login(uuid, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(citext), auth_ensure_user(uuid, citext, text, text, boolean),
  auth_record_login(uuid, boolean, int, int) TO eazy_app;
GRANT EXECUTE ON FUNCTION app_tenant(), app_user(), app_all_branches(), app_branch_ids() TO eazy_app;
