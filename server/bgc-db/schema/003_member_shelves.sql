-- Phase 2: every member has their own shelf, imported from BGG. Direct queries (no Airtable adapter).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 003_member_shelves.sql  (safe to re-run)
BEGIN;
CREATE SCHEMA IF NOT EXISTS bgc;

-- Progress of a member's BGG import: { state: running|done|error, step, games, expansions, plays, players, message, at }
ALTER TABLE members ADD COLUMN IF NOT EXISTS import_status jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION bgc.member_id(email text) RETURNS bigint LANGUAGE sql STABLE AS
$$ SELECT id FROM members WHERE google_email = email $$;

CREATE OR REPLACE FUNCTION bgc.set_import(email text, patch jsonb) RETURNS jsonb LANGUAGE sql AS $$
  UPDATE members SET import_status = import_status || patch || jsonb_build_object('at', at.iso(now())), updated_at = now()
  WHERE google_email = email RETURNING import_status $$;

-- Start an import: remember the BGG username, mark it running (refuses a second one while the first runs)
CREATE OR REPLACE FUNCTION bgc.start_import(email text, username text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE st jsonb;
BEGIN
  SELECT import_status INTO st FROM members WHERE google_email = email FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no member %', email; END IF;
  IF st ->> 'state' = 'running' AND (st ->> 'at')::timestamptz > now() - interval '15 minutes' THEN
    RETURN jsonb_build_object('ok', false, 'message', 'An import is already running');
  END IF;
  UPDATE members SET bgg_username = username,
    import_status = jsonb_build_object('state', 'running', 'step', 'Reading your BGG collection', 'username', username, 'started', at.iso(now()), 'at', at.iso(now()))
  WHERE google_email = email;
  RETURN jsonb_build_object('ok', true);
END $$;

-- items: [{ bggId, subtype: boardgame|boardgameexpansion, name, year }]  (owned games from the BGG collection)
-- Base games go on the shelf (catalog rows are shared, so games anyone already has are reused);
-- expansions become catalog rows and are attached to their base game once enriched.
CREATE OR REPLACE FUNCTION bgc.import_collection(email text, items jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); n_added int := 0; n_had int; next_num int; enrich jsonb;
BEGIN
  IF mid IS NULL THEN RAISE EXCEPTION 'no member %', email; END IF;
  INSERT INTO games (bgg_id, title, year)
    SELECT DISTINCT ON ((x ->> 'bggId')::int) (x ->> 'bggId')::int, coalesce(nullif(x ->> 'name', ''), 'BGG #' || (x ->> 'bggId')), nullif((x ->> 'year')::int, 0)
    FROM jsonb_array_elements(items) x WHERE (x ->> 'bggId')::int > 0
    ON CONFLICT (bgg_id) DO NOTHING;
  SELECT count(*) INTO n_had FROM shelves WHERE member_id = mid;
  SELECT coalesce(max(num), 0) INTO next_num FROM shelves WHERE member_id = mid;
  WITH base AS (
    SELECT DISTINCT g.id AS gid, g.title FROM jsonb_array_elements(items) x JOIN games g ON g.bgg_id = (x ->> 'bggId')::int
    WHERE coalesce(x ->> 'subtype', 'boardgame') <> 'boardgameexpansion'
      AND NOT EXISTS (SELECT 1 FROM shelves s WHERE s.member_id = mid AND s.game_id = g.id)),
  numbered AS (SELECT gid, next_num + row_number() OVER (ORDER BY lower(title)) AS n FROM base),
  ins AS (INSERT INTO shelves (member_id, game_id, num, legacy_id) SELECT mid, gid, n, at.new_key() FROM numbered RETURNING 1)
  SELECT count(*) INTO n_added FROM ins;
  -- Everything from this collection still lacking BGG details (base games and expansions)
  SELECT coalesce(jsonb_agg(DISTINCT g.bgg_id), '[]') INTO enrich
  FROM jsonb_array_elements(items) x JOIN games g ON g.bgg_id = (x ->> 'bggId')::int
  WHERE g.enriched_at IS NULL OR g.cover_card IS NULL
     OR (x ->> 'subtype' = 'boardgameexpansion');  -- expansions are re-read to find their base game
  RETURN jsonb_build_object('added', n_added, 'alreadyHad', n_had,
    'expansions', (SELECT count(*) FROM jsonb_array_elements(items) x WHERE x ->> 'subtype' = 'boardgameexpansion'),
    'enrich', enrich);
END $$;

-- things: parsed BGG thing items [{ id, type, name, year, weight, minPlayers, maxPlayers, minTime, maxTime, minAge, rank, rating,
--   bestPlayers, designers, categories, mechanics, coverCard, coverLarge, baseIds }]
-- Fills the shared catalog, and attaches owned expansions (by name) to the member's copy of their base game.
CREATE OR REPLACE FUNCTION bgc.enrich_games(email text, things jsonb, owned_expansions jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); t jsonb; n int := 0; attached int := 0; base_shelf record; exp_name text;
BEGIN
  FOR t IN SELECT * FROM jsonb_array_elements(things) LOOP
    UPDATE games SET
      title       = CASE WHEN enriched_at IS NULL AND coalesce(t ->> 'name', '') <> '' THEN t ->> 'name' ELSE title END,
      year        = coalesce(nullif((t ->> 'year')::int, 0), year),
      weight      = coalesce(nullif((t ->> 'weight')::numeric, 0), weight),
      min_players = coalesce(nullif((t ->> 'minPlayers')::int, 0), min_players),
      max_players = coalesce(nullif((t ->> 'maxPlayers')::int, 0), max_players),
      min_time    = coalesce(nullif((t ->> 'minTime')::int, 0), min_time),
      max_time    = coalesce(nullif((t ->> 'maxTime')::int, 0), max_time),
      min_age     = coalesce(nullif((t ->> 'minAge')::int, 0), min_age),
      bgg_rank    = coalesce(nullif((t ->> 'rank')::int, 0), bgg_rank),
      bgg_rating  = coalesce(nullif((t ->> 'rating')::numeric, 0), bgg_rating),
      best_players= CASE WHEN jsonb_array_length(coalesce(t -> 'bestPlayers', '[]')) > 0 THEN ARRAY(SELECT jsonb_array_elements_text(t -> 'bestPlayers'))::smallint[] ELSE best_players END,
      designers   = CASE WHEN jsonb_array_length(coalesce(t -> 'designers', '[]')) > 0 THEN ARRAY(SELECT jsonb_array_elements_text(t -> 'designers')) ELSE designers END,
      categories  = CASE WHEN jsonb_array_length(coalesce(t -> 'categories', '[]')) > 0 THEN ARRAY(SELECT jsonb_array_elements_text(t -> 'categories')) ELSE categories END,
      mechanics   = CASE WHEN jsonb_array_length(coalesce(t -> 'mechanics', '[]')) > 0 THEN ARRAY(SELECT jsonb_array_elements_text(t -> 'mechanics')) ELSE mechanics END,
      cover_card  = coalesce(nullif(t ->> 'coverCard', ''), cover_card),
      cover_large = coalesce(nullif(t ->> 'coverLarge', ''), cover_large),
      enriched_at = now(), updated_at = now()
    WHERE bgg_id = (t ->> 'id')::int;
    n := n + 1;
    -- An owned expansion: add its name to the member's copy of its base game (once)
    IF owned_expansions @> to_jsonb((t ->> 'id')::int) THEN
      SELECT s.member_id, s.game_id, g.title INTO base_shelf FROM shelves s JOIN games g ON g.id = s.game_id
      WHERE s.member_id = mid AND g.bgg_id IN (SELECT (b)::int FROM jsonb_array_elements_text(coalesce(t -> 'baseIds', '[]')) b)
      ORDER BY s.num LIMIT 1;
      IF FOUND THEN
        -- "Catan: Seafarers" on Catan reads as "Seafarers" (the base game's name is already on the card)
        exp_name := t ->> 'name';
        IF lower(left(exp_name, length(base_shelf.title))) = lower(base_shelf.title) AND length(exp_name) > length(base_shelf.title) + 2 THEN
          exp_name := btrim(substr(exp_name, length(base_shelf.title) + 1), ' :–—-');
        END IF;
        UPDATE shelves SET expansions = expansions || exp_name, updated_at = now()
        WHERE member_id = base_shelf.member_id AND game_id = base_shelf.game_id AND NOT (exp_name = ANY (expansions));
        attached := attached + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('enriched', n, 'expansionsAttached', attached);
END $$;

-- After plays are stored: the member's player list (anyone with 3+ plays, plus the member themselves),
-- seats linked to it, and play counts on their shelf
CREATE OR REPLACE FUNCTION bgc.refresh_member(email text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); uname text; me_name text; n_players int;
BEGIN
  SELECT bgg_username, display_name INTO uname, me_name FROM members WHERE id = mid;
  -- The member's own seat: their BGG username in the logs, else their display name
  INSERT INTO players (owner_id, name, active, linked_member_id, legacy_id)
  SELECT mid, coalesce((SELECT pp.name FROM play_players pp JOIN plays p ON p.id = pp.play_id
                        WHERE p.owner_id = mid AND lower(pp.bgg_user) = lower(uname) GROUP BY pp.name ORDER BY count(*) DESC LIMIT 1), me_name),
         true, mid, at.new_key()
  WHERE NOT EXISTS (SELECT 1 FROM players WHERE owner_id = mid AND linked_member_id = mid)
  ON CONFLICT (owner_id, name) DO UPDATE SET linked_member_id = mid;
  INSERT INTO players (owner_id, name, active, legacy_id)
  SELECT mid, pp.name, sum(p.quantity) >= 10, at.new_key()
  FROM play_players pp JOIN plays p ON p.id = pp.play_id
  WHERE p.owner_id = mid AND pp.player_id IS NULL AND pp.name <> '' AND pp.name !~* '^anonymous'
  GROUP BY pp.name HAVING sum(p.quantity) >= 3
  ON CONFLICT (owner_id, name) DO NOTHING;
  PERFORM at.save_plays(email, '[]'::jsonb); -- links seats to the new players
  UPDATE shelves s SET
    play_count = coalesce(x.plays, 0), last_played = x.last, updated_at = now()
  FROM (
    SELECT s2.game_id, sum(p.quantity)::int AS plays, max(p.played_on) AS last
    FROM shelves s2 JOIN games g ON g.id = s2.game_id
    LEFT JOIN plays p ON p.owner_id = s2.member_id AND (p.bgg_id = g.bgg_id OR p.bgg_id = ANY (s2.extra_bgg_ids))
    WHERE s2.member_id = mid GROUP BY s2.game_id) x
  WHERE s.member_id = mid AND s.game_id = x.game_id;
  SELECT count(*) INTO n_players FROM players WHERE owner_id = mid;
  RETURN jsonb_build_object('players', n_players);
END $$;

-- A member's shelf in the same shape the site already uses for the main collection
CREATE OR REPLACE FUNCTION bgc.shelf(email text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'records', coalesce((SELECT jsonb_agg(at.game_record(s) ORDER BY s.num NULLS LAST, s.legacy_id) FROM shelves s WHERE s.member_id = m.id), '[]'),
    'status', m.import_status, 'bggUsername', m.bgg_username, 'name', m.display_name)
  FROM members m WHERE m.google_email = email $$;

-- Personal fields on the member's own copy only (the catalog is shared and isn't editable here)
CREATE OR REPLACE FUNCTION bgc.shelf_update(email text, skey text, f jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s shelves;
BEGIN
  UPDATE shelves SET
    favorite     = CASE WHEN f ? 'favorite' THEN coalesce((f ->> 'favorite')::boolean, false) ELSE favorite END,
    want_to_play = CASE WHEN f ? 'desireToPlay' THEN least(5, greatest(0, coalesce((f ->> 'desireToPlay')::int, 0))) ELSE want_to_play END,
    thinning     = CASE WHEN f ? 'thinningCandidate' THEN coalesce((f ->> 'thinningCandidate')::boolean, false) ELSE thinning END,
    updated_at   = now()
  WHERE member_id = bgc.member_id(email) AND legacy_id = skey RETURNING * INTO s;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That game isn''t on your shelf'); END IF;
  RETURN jsonb_build_object('ok', true, 'id', skey);
END $$;

CREATE OR REPLACE FUNCTION bgc.shelf_remove(email text, skey text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE gid bigint; t text;
BEGIN
  DELETE FROM shelves WHERE member_id = bgc.member_id(email) AND legacy_id = skey RETURNING game_id INTO gid;
  IF gid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That game isn''t on your shelf'); END IF;
  SELECT title INTO t FROM games WHERE id = gid;
  PERFORM at.drop_orphan_game(gid);
  RETURN jsonb_build_object('ok', true, 'id', skey, 'title', t);
END $$;

COMMIT;
