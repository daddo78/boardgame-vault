-- Two functions nothing calls any more (checked across schema/, the API's src/ and n8n/gen.js):
--   bgc.import_collection (003): the first BGG import; the Import BGG workflow adds games one by one with bgc.shelf_add (006)
--                                and finishes with bgc.refresh_member
--   at.find_rating (005): written for the Rate workflow, which went to bgc.rate (014) instead; at.request never reads it
-- Left alone on purpose: at.rating_records() and at.delete_rating are reached through at.request's GET/DELETE on the ratings
-- table (nothing calls them today, but the adapter still routes there), and the friend_takes table is a planned phase.
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 043_dead_functions.sql
BEGIN;

DROP FUNCTION IF EXISTS bgc.import_collection(text, jsonb);
DROP FUNCTION IF EXISTS at.find_rating(text);

COMMIT;
