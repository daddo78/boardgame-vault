-- Each nightly backup records how it went, so a daily health check can email when backups stop.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 004_backup_runs.sql  (apply once via apply.sh)
CREATE TABLE IF NOT EXISTS backup_runs (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  ok       boolean NOT NULL,
  message  text NOT NULL DEFAULT ''
);
-- Keep a year of history
DELETE FROM backup_runs WHERE at < now() - interval '400 days';
