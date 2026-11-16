-- Board Game Curator is fully off n8n (Dan, Nov 16): the page sends every request to the API, so the switches that
-- moved it over one area at a time are gone (the API's /vault/routes, /vault/api-areas and /vault/nathan-mode, and
-- Admin's New API and Nathan's service switch). Their saved values are dropped here; nothing else reads them.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 054_retire_api_switches.sql  (or bash apply.sh)
BEGIN;

DELETE FROM settings WHERE key IN ('api_areas', 'nathan_api');

COMMIT;
