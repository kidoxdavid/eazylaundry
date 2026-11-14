# 06 — Multi-Tenant Security Architecture, Permission Matrix, Threat Assessment

## 1. Isolation layers (defence in depth)
1. **Identity → tenant resolution:** active tenant comes from a server-verified `user_memberships` row bound to the session. Request headers/body/URL tenant ids are never trusted (storefront resolves tenant from verified host mapping; portal from the customer's tenant-scoped identity).
2. **Service-layer authorization:** every use case checks permission + branch scope via a central `AuthorizationService` (`can(actor, permission, resource)`); no controller-only checks.
3. **PostgreSQL RLS:** every tenant table `FORCE ROW LEVEL SECURITY`; API connects as non-owner, non-BYPASSRLS role; per-transaction `SET LOCAL app.tenant_id / app.user_id / app.branch_ids / app.actor_kind`. Missing context → zero rows (policy uses `current_setting(..., true)` returning NULL → false).
4. **Composite FKs** (tenant_id, id) prevent cross-tenant references.
5. **Object storage:** keys prefixed `tenants/{tenant_id}/…`; access only via short-lived signed URLs minted after authz.
6. **Cache/queue:** Redis keys and job payloads namespaced with tenant id; workers re-establish context.
7. **Automated tests** attempting cross-tenant reads/writes through every endpoint (11).

```sql
-- pattern (illustrative)
ALTER TABLE orders ENABLE ROW LEVEL SECURITY; ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- branch-restricted users additionally:
CREATE POLICY branch_scope ON orders AS RESTRICTIVE
  USING (current_setting('app.all_branches', true) = 'true'
         OR branch_id = ANY (string_to_array(current_setting('app.branch_ids', true), ',')::uuid[]));
```

## 2. Eazy Group: provider vs operator
- **Platform context** (`platform_users`, `app_platform` role, platform console on a separate host/deployment): can see tenant metadata (plan, status, usage, health) — **not** orders, customers, finances.
- **Eazy Laundry Services** is a normal tenant. Eazy staff log in via the normal tenant app with tenant memberships.
- A platform user accessing tenant data requires a **support access grant**: tenant-owner-approved, scoped (read-only default; scopes e.g. `orders.read`, `config.read`), time-limited (max 24 h), reason recorded, visible banner to tenant users, every action audited with `via_support_grant_id`, auto-expiry, revocable at once. Break-glass for security incidents: two-person approval, tenant notified after the fact; logged to a separate immutable stream.
- Platform admins cannot read passwords, MFA secrets, or integration credentials under any scope.

## 3. Authentication & session
Argon2id; breached-password check (HIBP k-anonymity optional); MFA TOTP (required for owners/finance, recommended otherwise; WebAuthn later); rate-limit and progressive lockout per account+IP; session rotation on privilege change; idle (30 min staff kiosk configurable) and absolute timeouts; device/session list with revoke; password-reset via single-use hashed token; OTP for delivery proof is separate (6-digit, 10-min, attempts-limited). Kiosk mode: PIN quick-switch **on top of** a device-authorized session, limited to staff-role permissions.

## 4. Authorization model
RBAC + permission codes + scoped grants:
- Permission code `domain.resource.action` (e.g., `order.create`, `payment.refund.approve`).
- Role = set of permissions; tenant can clone/edit roles, **but** cannot grant permissions it doesn't itself hold, and users cannot edit their own role/membership (enforced + tested).
- Branch scope from `membership_branches`; owners `all_branches`.
- Amount limits via `permission_limits` (discount %, refund amount); over-limit → approval workflow requiring a different user with higher limit (**no self-approval**).
- Sensitive permissions (`finance.*`, `role.manage`, `export.*`, `employee.pay.read`) are separately listed and audit-flagged.

## 5. Permission matrix (default role templates)
✔ = allowed · B = own branch(es) only · L = limited (threshold/own records) · — = no

| Permission area | Owner | Branch Mgr | Finance | Cashier | Production Tech | QC Inspector | Driver | Dispatcher |
|---|---|---|---|---|---|---|---|---|
| Tenant/org settings | ✔ | — | — | — | — | — | — | — |
| Roles & permissions | ✔ | — | — | — | — | — | — | — |
| Branch settings | ✔ | B (view) | — | — | — | — | — | — |
| Employees (CRUD) | ✔ | B | — | — | — | — | — | — |
| Employee pay data | ✔ | — | ✔ | — | — | — | own | — |
| Customers read/create | ✔ | B | read | ✔ | read-lite | read-lite | assigned | read |
| Customer export/delete | ✔ | — | — | — | — | — | — | — |
| Services & prices edit | ✔ | — | — | — | — | — | — | — |
| Create/edit order | ✔ | B | — | ✔ | — | — | — | B |
| Discount | ✔ | B (higher limit) | — | L | — | — | — | — |
| Cancel order | ✔ | B | — | L (pre-process) | — | — | — | — |
| Take payment | ✔ | B | ✔ | ✔ | — | — | — | — |
| Refund / adjustment request | ✔ | B | ✔ | request | — | — | — | — |
| Refund approve | ✔ | B (limit) | ✔ (limit) | — | — | — | — | — |
| Cash shift open/close | ✔ | B | ✔ | own shift | — | — | — | — |
| Production stage advance | ✔ | B | — | L (handover) | role stages | QC stage | — | — |
| QC pass/fail | ✔ | B | — | — | — | ✔ | — | — |
| Delivery assign/dispatch | ✔ | B | — | — | — | — | — | ✔ |
| Delivery task execute | — | — | — | — | — | — | own tasks | — |
| Driver pay config | ✔ | — | ✔ | — | — | — | — | — |
| Inventory adjust/receive | ✔ | B | ✔ | — | L (consume) | — | — | — |
| Expenses / AP | ✔ | B (submit) | ✔ | — | — | — | — | — |
| Ledger & financial reports | ✔ | B (own branch) | ✔ | — | — | — | — | — |
| Dashboards (exec) | ✔ | B | ✔ | — | — | — | — | — |
| Integrations | ✔ | — | — | — | — | — | — | — |
| Audit log view | ✔ | B (limited) | ✔ (finance) | — | — | — | — | — |
| Data export | ✔ | — | L | — | — | — | — | — |
| Billing & plan | ✔ | — | ✔ (view) | — | — | — | — | — |

Customer portal principals can only access their own customer record, orders, invoices; B2B portal users only their commercial account per role (`account_admin`, `orderer`, `viewer`). Platform roles: `platform_admin`, `billing_ops`, `support_agent` (no tenant data without grant), `security_officer`.

## 6. Threat assessment (STRIDE-oriented, top threats)
| ID | Threat | Impact | Mitigations |
|---|---|---|---|
| T1 | Cross-tenant data access via IDOR/missing filter | Critical | RLS + composite FKs + authz service + generated cross-tenant tests per endpoint |
| T2 | Privilege escalation (self-grant roles) | Critical | No self-edit; grant ≤ own permissions; audit; tests |
| T3 | Stolen session/credential | High | MFA, short idle timeouts, session binding, rotation, anomaly alerts, cookie flags |
| T4 | Payment fraud / refund abuse by staff | High | Thresholds, separate approver, refund linked to original payment, shift reconciliation, anomaly rules |
| T5 | Duplicate/forged payment webhooks | High | Signature verification, event-id dedupe, idempotent handlers, reconcile job against provider |
| T6 | Injection (SQL/XSS) | High | Parameterized queries only (Drizzle), Zod validation, output encoding, strict CSP, sanitize rich text |
| T7 | Malicious file upload | Medium | MIME sniffing, size caps, re-encode images, AV scan, separate download domain, no executable serving |
| T8 | Storefront tenant takeover via custom domain/subdomain confusion | High | DNS TXT ownership proof, host→tenant mapping, reserved slugs, wildcard cert hygiene |
| T9 | Support-access abuse | High | Consented, scoped, time-limited grants; banner; audit; alerts on use |
| T10 | PII breach (customer data) | High | Encryption at rest/in transit, field-level encryption for sensitive fields (e.g., employee SIN excluded — **do not collect SIN**), least-privilege roles, log scrubbing, breach runbook (PIPEDA breach reporting) |
| T11 | Integration secret leakage | High | KMS envelope encryption, never returned, rotation, secret scanning in CI |
| T12 | Tenant noisy neighbour / DoS | Medium | Rate limits per tenant+IP, queue fairness, statement timeouts, connection pool limits |
| T13 | Backup compromise / deletion | High | Cross-account, cross-region, immutable backups; restore drills |
| T14 | AI assistant prompt injection → unauthorized action | Medium (F) | Read-only tools, authz propagated, no free-form SQL, human confirmation for writes |
| T15 | OTP/proof-of-delivery bypass | Medium | Attempt limits, OTP bound to task, photo + timestamp + (consented) location provenance |
| T16 | Supply-chain compromise | Medium | Lockfiles, Dependabot/Renovate, SBOM, pinned CI actions, `npm audit` gate |

## 7. Privacy (PIPEDA, Alberta PIPA)
Purpose limitation & consent records (`customer_consents`), CASL-compliant commercial messaging (express/implied consent, unsubscribe), access/correction requests (DSAR export), retention policies per tenant with legal minimums (financial records 6 years in Canada — configurable default), breach response runbook & log, data residency in Canada, Eazy as **service provider/processor** for tenants (DPA template), tenant offboarding export/deletion. *No compliance certification is claimed; SOC 2 / independent pen test are P1+ roadmap items.*

## 8. Secure SDLC
Secrets only via env/Secrets Manager; pre-commit + CI secret scan; SAST (CodeQL), dependency audit, container scan (Trivy); required PR review; threat-model update per major feature; annual (pre-GA: before first paying external tenant) third-party penetration test.
