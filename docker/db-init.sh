#!/usr/bin/env bash
# One-shot init job of the compose stack (rule 34: the same forward-only migrations as `supabase db push`): applies
# every supabase/migrations/NNNN_<module>_<topic>.sql not applied yet, in order, each in one transaction, recording it
# in supabase_migrations.schema_migrations exactly as the Supabase CLI does; then supabase/seed.sql once (when it has
# content), recorded in supabase_migrations.seed_files. Runs after Auth and Storage created their schemas (the
# migrations reference auth.users and storage.buckets). Safe to run again: applied files are skipped.
set -euo pipefail

: "${PGHOST:?}" "${PGUSER:?}" "${PGPASSWORD:?}" "${PGDATABASE:?}"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-/supabase/migrations}"
SEED_FILE="${SEED_FILE:-/supabase/seed.sql}"
psql_q() { psql -v ON_ERROR_STOP=1 -X -q "$@"; }

psql_q <<'SQL'
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
create table if not exists supabase_migrations.seed_files (path text primary key, hash text not null);
SQL

applied=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  base="$(basename "$file" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  if [ -n "$(psql -X -tAc "select 1 from supabase_migrations.schema_migrations where version = '$version'")" ]; then
    continue
  fi
  echo "db-init: applying $base"
  psql_q --single-transaction -f "$file" \
    -c "insert into supabase_migrations.schema_migrations(version, name) values ('$version', '$name')"
  applied=$((applied + 1))
done
echo "db-init: $applied migration(s) applied"

if [ -s "$SEED_FILE" ] && grep -qv '^\s*\(--.*\)\?$' "$SEED_FILE"; then
  hash="$(sha256sum "$SEED_FILE" | cut -d' ' -f1)"
  if [ -z "$(psql -X -tAc "select 1 from supabase_migrations.seed_files where path = 'supabase/seed.sql'")" ]; then
    echo "db-init: seeding"
    psql_q --single-transaction -f "$SEED_FILE" \
      -c "insert into supabase_migrations.seed_files(path, hash) values ('supabase/seed.sql', '$hash')"
  fi
fi
echo "db-init: done"
