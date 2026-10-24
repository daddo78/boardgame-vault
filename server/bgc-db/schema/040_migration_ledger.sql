-- A ledger of which migrations have been applied, so apply.sh can run the pending ones once and skip the rest.
-- Until now every file was applied by hand and most said "safe to re-run"; 024 wasn't (its DROP TABLE became a view),
-- and re-running a file that redefines a function is harmless but hides which version is live. One row per file, by number.
-- Everything through 039 is on the server already, so 001..039 are seeded as applied, and 040 itself.
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 040_migration_ledger.sql
--   (from here on: cd ~/bgc-db/schema && bash apply.sh, which also applies this file itself on a server without the ledger)
BEGIN;

CREATE TABLE IF NOT EXISTS bgc.schema_migrations (
  version     text PRIMARY KEY,                 -- the file's number, e.g. '040'
  applied_at  timestamptz NOT NULL DEFAULT now());

INSERT INTO bgc.schema_migrations (version)
SELECT lpad(n::text, 3, '0') FROM generate_series(1, 40) n
ON CONFLICT DO NOTHING;

COMMIT;
