-- The shelf is managed here, not on BGG: connecting BGG brings in plays only (no games), and a spreadsheet (CSV)
-- of games is the fast way to fill a big shelf. Plays attach to a game as soon as it's on the shelf.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 010_csv_import.sql  (apply once via apply.sh)
BEGIN;

-- Connecting BGG: remember the username and read their plays (no games)
CREATE OR REPLACE FUNCTION bgc.start_import(email text, username text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE st jsonb;
BEGIN
  SELECT import_status INTO st FROM members WHERE google_email = email FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no member %', email; END IF;
  IF st ->> 'state' = 'running' AND (st ->> 'at')::timestamptz > now() - interval '15 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'An import is already running');
  END IF;
  UPDATE members SET bgg_username = username,
    import_status = jsonb_build_object('state', 'running', 'kind', 'bgg', 'step', 'Reading your plays from BGG', 'username', username, 'started', at.iso(now()), 'at', at.iso(now()))
  WHERE google_email = email;
  RETURN jsonb_build_object('ok', true);
END $$;

-- rows: [{ title, bggId, year }] from the member's spreadsheet.
-- Each row becomes a BGG id: the id column if there is one, else the game they logged plays for under that name,
-- else a game already in the catalog with that title. Rows still unknown are looked up on BGG by the workflow.
CREATE OR REPLACE FUNCTION bgc.start_csv(email text, rows jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); st jsonb; ids jsonb; search jsonb; n_have int; n_rows int;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  SELECT import_status INTO st FROM members WHERE id = mid FOR UPDATE;
  IF st ->> 'state' = 'running' AND (st ->> 'at')::timestamptz > now() - interval '30 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'message', 'An import is already running. Give it a few minutes.');
  END IF;
  WITH r AS (
    SELECT nullif(btrim(x ->> 'title'), '') AS t,
           CASE WHEN x ->> 'bggId' ~ '^\d{1,7}$' THEN (x ->> 'bggId')::int END AS b,
           CASE WHEN x ->> 'year' ~ '^\d{4}$' THEN (x ->> 'year')::int END AS y
    FROM jsonb_array_elements(rows) x),
  res AS (
    SELECT t, y, coalesce(b,
      (SELECT p.bgg_id FROM plays p WHERE p.owner_id = mid AND lower(p.game_name) = lower(r.t) GROUP BY p.bgg_id ORDER BY count(*) DESC LIMIT 1),
      (SELECT g.bgg_id FROM games g WHERE g.bgg_id IS NOT NULL AND lower(g.title) = lower(r.t)
        ORDER BY (g.year = r.y) DESC NULLS LAST, g.bgg_rank NULLS LAST LIMIT 1)) AS bgg
    FROM r WHERE t IS NOT NULL OR b IS NOT NULL)
  SELECT
    coalesce(jsonb_agg(DISTINCT bgg) FILTER (WHERE bgg IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = mid AND g.bgg_id = res.bgg)), '[]'),
    coalesce(jsonb_agg(DISTINCT jsonb_build_object('title', t, 'year', y)) FILTER (WHERE bgg IS NULL), '[]'),
    count(*) FILTER (WHERE bgg IS NOT NULL AND EXISTS (
      SELECT 1 FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = mid AND g.bgg_id = res.bgg)),
    count(*)
  INTO ids, search, n_have, n_rows FROM res;
  UPDATE members SET import_status = jsonb_build_object('state', 'running', 'kind', 'csv', 'step', 'Matching your list',
    'rows', n_rows, 'started', at.iso(now()), 'at', at.iso(now())) WHERE id = mid;
  RETURN jsonb_build_object('ok', true, 'ids', ids, 'search', search, 'alreadyHad', n_have);
END $$;

-- things: parsed BGG things for the matched games; unmatched: titles nobody could find.
-- Base games go on first, so an expansion in the same list lands under its base game.
CREATE OR REPLACE FUNCTION bgc.csv_add(email text, things jsonb, unmatched jsonb, already int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE t jsonb; r jsonb; n_added int := 0; n_exp int := 0; n_had int := coalesce(already, 0); fails jsonb := coalesce(unmatched, '[]');
BEGIN
  FOR t IN SELECT x FROM jsonb_array_elements(coalesce(things, '[]')) x ORDER BY (x ->> 'type' = 'boardgameexpansion'), lower(x ->> 'name') LOOP
    r := bgc.shelf_add(email, t, NULL);
    IF (r ->> 'ok')::boolean THEN
      IF r ? 'expansions' THEN n_exp := n_exp + 1; ELSE n_added := n_added + 1; END IF;
    ELSIF r ->> 'status' = '409' THEN n_had := n_had + 1;
    ELSE fails := fails || to_jsonb(coalesce(t ->> 'name', 'BGG #' || (t ->> 'id')));
    END IF;
  END LOOP;
  RETURN bgc.set_import(email, jsonb_build_object('state', 'done', 'kind', 'csv', 'step', 'Done', 'added', n_added, 'expansions', n_exp,
    'alreadyHad', n_had, 'notFound', fails, 'finished', at.iso(now())));
END $$;

COMMIT;
