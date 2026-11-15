#!/bin/bash
# Creates the four database roles and the database on first start of a fresh Postgres volume.
# Passwords come from the environment (never from source); use URL-safe values (e.g. `openssl rand -hex 24`).
set -euo pipefail
: "${EAZY_OWNER_PASSWORD:?required}" "${EAZY_APP_PASSWORD:?required}" "${EAZY_WORKER_PASSWORD:?required}" "${EAZY_PLATFORM_PASSWORD:?required}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres \
  -v owner_pw="$EAZY_OWNER_PASSWORD" -v app_pw="$EAZY_APP_PASSWORD" -v worker_pw="$EAZY_WORKER_PASSWORD" -v platform_pw="$EAZY_PLATFORM_PASSWORD" <<'SQL'
CREATE ROLE eazy_owner LOGIN PASSWORD :'owner_pw';
CREATE ROLE eazy_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
CREATE ROLE eazy_worker LOGIN PASSWORD :'worker_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
CREATE ROLE eazy_platform LOGIN PASSWORD :'platform_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
CREATE DATABASE eazylaundry OWNER eazy_owner;
SQL
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d eazylaundry -c "CREATE EXTENSION IF NOT EXISTS citext; CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS pg_trgm;"
