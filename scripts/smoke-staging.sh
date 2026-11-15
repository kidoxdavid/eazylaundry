#!/usr/bin/env bash
# Smoke test for the staging stack (docker-compose.staging.yml). Exercises the real path: nginx -> API -> Postgres (RLS roles).
#   scripts/smoke-staging.sh [http://localhost:8080]
set -uo pipefail
BASE="${1:-http://localhost:8080}"; JAR="$(mktemp)"; FAILS=0
ok()   { echo "  ok   $1"; }
fail() { echo "  FAIL $1"; FAILS=$((FAILS+1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$name"; else fail "$name"; fi; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "waiting for $BASE ..."
for i in $(seq 1 60); do [ "$(code "$BASE/api/health")" = "200" ] && break; sleep 2; done

[ "$(code "$BASE/healthz")" = "200" ] && ok "web healthz" || fail "web healthz"
[ "$(code "$BASE/api/health")" = "200" ] && ok "API health through nginx (database reachable)" || fail "API health through nginx"
[ "$(code "$BASE/orders")" = "200" ] && ok "SPA fallback serves deep links" || fail "SPA fallback"
H="$(curl -sI "$BASE/")"
for h in "content-security-policy" "x-frame-options" "x-content-type-options" "referrer-policy"; do echo "$H" | grep -qi "^$h:" && ok "header $h" || fail "header $h"; done

EMAIL="smoke-$(date +%s)@example.test"
R="$(code -c "$JAR" -X POST "$BASE/api/auth/register" -H 'content-type: application/json' \
  -d "{\"businessName\":\"Smoke Co\",\"ownerName\":\"Smoke Test\",\"email\":\"$EMAIL\",\"password\":\"correct-horse-battery\",\"branchName\":\"Main\",\"branchCode\":\"MAIN\"}")"
[ "$R" = "201" ] && ok "register a business (migrations applied, app role can write under RLS)" || fail "register ($R)"
[ "$(code -b "$JAR" "$BASE/api/auth/me")" = "200" ] && ok "session works" || fail "session"
[ "$(code -b "$JAR" "$BASE/api/branches")" = "200" ] && ok "tenant data readable" || fail "tenant data"
[ "$(code -b "$JAR" -X POST "$BASE/api/branches" -H 'content-type: application/json' -d '{"code":"X1","name":"No CSRF"}')" = "403" ] && ok "state-changing request without CSRF token is refused" || fail "CSRF enforcement"
[ "$(code "$BASE/api/branches")" = "401" ] && ok "unauthenticated request is refused" || fail "unauthenticated access"
[ "$(code "$BASE/api/platform/auth/me")" = "401" ] && ok "platform realm enabled and protected" || fail "platform realm"
[ "$(code "$BASE/api/reports/sales?from=2026-01-01&to=2026-01-02")" = "401" ] && ok "reports require sign-in" || fail "reports auth"
# the API container must not be reachable from outside the compose network
if curl -s --max-time 2 -o /dev/null "http://localhost:3000/health"; then fail "API port 3000 is exposed on the host"; else ok "API is not published on the host"; fi

rm -f "$JAR"
if [ "$FAILS" -gt 0 ]; then echo "$FAILS check(s) failed"; exit 1; fi
echo "all checks passed"
