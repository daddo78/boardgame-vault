-- Every run of a background job (the bgc-jobs worker: nightly play syncs, Fill Catalog, the rulebook reader, cost
-- readings, the backup check, the nightly self-test, and the imports the API hands it): when, how it went, and a short
-- summary. What n8n's execution list used to show. The worker emails Dan when a run fails (one email per job per 30 min).
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 044_job_runs.sql  (or bash apply.sh)
BEGIN;

CREATE TABLE IF NOT EXISTS job_runs (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,                    -- syncPlays, syncPeople, memberPlays, fillCatalog, ruleReader, healthCheck, aiUsage, selfTest, shelfCsv
  trigger     text NOT NULL DEFAULT 'schedule', -- schedule, api (handed over by a request), run (asked for by hand)
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,                          -- null while running
  summary     jsonb,                            -- what the job reports when it's done (counts, mostly)
  error       text);
CREATE INDEX IF NOT EXISTS job_runs_name_idx ON job_runs (name, started_at DESC);

-- Keep three months
DELETE FROM job_runs WHERE started_at < now() - interval '90 days';

COMMIT;
