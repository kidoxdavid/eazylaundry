#!/usr/bin/env bash
# Creates roles + databases for local dev/test. Needs a Postgres superuser:
# set PGSUPER_URL, or run as root on a box with a local 'postgres' OS user.
set -euo pipefail
run() { if [ -n "${PGSUPER_URL:-}" ]; then psql "$PGSUPER_URL" -v ON_ERROR_STOP=1 "$@"; else runuser -u postgres -- psql -v ON_ERROR_STOP=1 "$@"; fi; }
run -c "DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='eazy_owner') THEN CREATE ROLE eazy_owner LOGIN PASSWORD 'eazy_owner_dev' CREATEDB; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='eazy_app') THEN CREATE ROLE eazy_app LOGIN PASSWORD 'eazy_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB; END IF;
END \$\$;"
for db in eazylaundry eazylaundry_test; do
  if ! run -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then run -c "CREATE DATABASE $db OWNER eazy_owner"; fi
  run -d $db -c "CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
done
echo "bootstrap ok"
