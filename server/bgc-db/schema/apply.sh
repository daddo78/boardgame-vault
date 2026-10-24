#!/bin/bash
# Apply the pending migrations in order, once each, and record them in bgc.schema_migrations (040).
#   cd ~/bgc-db/schema && bash apply.sh          apply what's pending
#   bash apply.sh --dry-run                      only list what would be applied
# Each NNN_*.sql runs as one psql call with ON_ERROR_STOP inside the file's own BEGIN/COMMIT (a file without one is wrapped
# in a single transaction); its number is recorded only when psql succeeds, so a failed file is simply retried next time.
# A file whose header carries the line "-- apply.sh: always" is re-applied on every run (021, the generated self-check).
# First run on a server without the ledger: 040 is applied first (it marks 001..040 as applied, which they are).
set -euo pipefail
cd "$(dirname "$0")"
PSQL=(docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 -q)
dry=0; [ "${1:-}" = "--dry-run" ] && dry=1

sql() { "${PSQL[@]}" -At -c "$1"; }
has_ledger() { [ "$(sql "SELECT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'bgc' AND tablename = 'schema_migrations')")" = "t" ]; }

if has_ledger; then
  applied=$(sql "SELECT version FROM bgc.schema_migrations ORDER BY version")
elif [ $dry -eq 1 ]; then
  echo "no ledger yet: 040_migration_ledger.sql would go first (it marks 001..040 as applied)"
  applied=$(seq -f '%03g' 1 40)
else
  echo "no ledger yet: applying 040_migration_ledger.sql first"
  "${PSQL[@]}" < 040_migration_ledger.sql
  applied=$(sql "SELECT version FROM bgc.schema_migrations ORDER BY version")
fi

n=0
for f in [0-9][0-9][0-9]_*.sql; do
  v=${f%%_*}
  always=0; grep -q '^-- apply.sh: always' "$f" && always=1
  if [ $always -eq 0 ] && grep -qx "$v" <<< "$applied"; then continue; fi
  n=$((n + 1))
  if [ $dry -eq 1 ]; then echo "pending:  $f"; continue; fi
  opts=(); grep -qiE '^\s*BEGIN;' "$f" || opts=(-1)   # a file without its own transaction gets one
  echo "applying: $f"
  "${PSQL[@]}" ${opts[@]+"${opts[@]}"} < "$f"
  sql "INSERT INTO bgc.schema_migrations (version) VALUES ('$v') ON CONFLICT (version) DO UPDATE SET applied_at = now()" > /dev/null
done
if [ $n -eq 0 ]; then echo "nothing to apply (ledger at $(tail -n 1 <<< "$applied"))"
elif [ $dry -eq 1 ]; then echo "$n pending"
else echo "$n applied; ledger at $(sql "SELECT max(version) FROM bgc.schema_migrations")"; fi
