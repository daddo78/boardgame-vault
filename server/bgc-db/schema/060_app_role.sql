-- A login for the API and the jobs worker that isn't a superuser (review, Nov 16). Until now everything connected as
-- bgc, the superuser the Postgres image creates, so a bug in the API, or anything else that got the connection, could
-- do anything to the server (change any setting, read files, run commands through COPY ... PROGRAM). bgc_app can read
-- and write the data and run the bgc.* / at.* functions (they run with the caller's rights; none is SECURITY DEFINER),
-- and nothing more: no DDL, no superuser features. Migrations (apply.sh), backups and NocoDB keep using bgc.
-- The password is never in the repo: deploy.sh sets it from BGC_APP_PASSWORD in ~/bgc-db/.env on the server, and the
-- API uses bgc_app only once that is set (bgc-api/docker-compose.yml falls back to bgc until then).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 060_app_role.sql  (or bash apply.sh)
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bgc_app') THEN
    CREATE ROLE bgc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END $$;

-- bgc finds the bgc schema first through the default "$user", public; bgc_app gets the same order explicitly
ALTER ROLE bgc_app SET search_path = bgc, public;
GRANT CONNECT, TEMPORARY ON DATABASE bgc TO bgc_app;
GRANT USAGE ON SCHEMA public, bgc, at TO bgc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public, bgc, at TO bgc_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public, bgc, at TO bgc_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, bgc, at TO bgc_app;
-- Tables, sequences and functions that later migrations create (as bgc) come with the same rights
ALTER DEFAULT PRIVILEGES FOR ROLE bgc IN SCHEMA public, bgc, at GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bgc_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bgc IN SCHEMA public, bgc, at GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO bgc_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bgc IN SCHEMA public, bgc, at GRANT EXECUTE ON FUNCTIONS TO bgc_app;

COMMIT;
