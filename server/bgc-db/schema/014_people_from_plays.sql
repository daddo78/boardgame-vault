-- People lists come from logged plays (everyone you've played with, from 1 play), plus friends by code.
-- Signing in no longer adds you to Dan's people; your profile and ratings live on your own account.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 014_people_from_plays.sql  (safe to re-run)
BEGIN;

CREATE OR REPLACE FUNCTION at.request(tbl text, method text, path text, body jsonb, formula text)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  kind text := CASE tbl WHEN 'tblbGc0UuDxIPP2a8' THEN 'games' WHEN 'tblNahVdHDueJJ0w4' THEN 'players' WHEN 'tbllInOWIokikEiQH' THEN 'ratings' ELSE tbl END;
  one text := nullif(substring(coalesce(path, '') FROM '^/([^/?]+)'), '');
  m text[]; fkind text; fval text; recs jsonb := '[]'::jsonb; r jsonb; out jsonb; ids text[];
BEGIN
  method := upper(method);
  IF method = 'GET' THEN
    IF kind = 'games' THEN
      SELECT coalesce(jsonb_agg(at.game_record(s) ORDER BY s.num NULLS LAST, s.legacy_id), '[]') INTO recs FROM shelves s WHERE s.member_id = at.admin_id();
    ELSIF kind = 'players' THEN
      SELECT coalesce(jsonb_agg(at.player_record(p) ORDER BY p.name), '[]') INTO recs FROM players p WHERE p.owner_id = at.admin_id();
    ELSIF kind = 'ratings' THEN
      SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM at.rating_records() x;
    ELSE RAISE EXCEPTION 'unknown table %', tbl; END IF;
    IF one IS NOT NULL THEN
      SELECT x INTO out FROM jsonb_array_elements(recs) x WHERE x ->> 'id' = one;
      IF out IS NULL THEN RAISE EXCEPTION 'NOT_FOUND: % %', kind, one; END IF;
      RETURN out;
    END IF;
    IF coalesce(formula, '') <> '' THEN
      m := regexp_match(formula, '^\s*(RECORD_ID\(\)|\{GameID\}|\{Key\}|LOWER\(\{GoogleEmail\}\))\s*=\s*''(.*)''\s*$');
      IF m IS NULL THEN RAISE EXCEPTION 'unsupported formula: %', formula; END IF;
      fkind := m[1]; fval := replace(m[2], '\''', '''');
      IF fkind = 'LOWER({GoogleEmail})' AND kind = 'players' THEN
        -- A member signing in: their card in Dan's people list, if he plays with them (matched by name). No card is created:
        -- Dan's people come from his logged plays; profiles and ratings belong to the member's own account.
        UPDATE players pl SET linked_member_id = mm.id, updated_at = now()
        FROM members mm
        WHERE mm.google_email = fval AND pl.owner_id = at.admin_id() AND pl.linked_member_id IS NULL AND lower(pl.name) = lower(mm.display_name)
          AND NOT EXISTS (SELECT 1 FROM players x WHERE x.owner_id = at.admin_id() AND x.linked_member_id = mm.id);
        IF FOUND THEN
          SELECT coalesce(jsonb_agg(at.player_record(p)), '[]') INTO recs FROM players p WHERE p.owner_id = at.admin_id();
        END IF;
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE lower(x -> 'fields' ->> 'fldnwPL9Z33JcXoj2') = lower(fval);
      ELSIF fkind = '{GameID}' THEN
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE x -> 'fields' ->> 'fldJ1g6gtxWDwlWsI' = fval;
      ELSIF fkind = '{Key}' THEN
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE x -> 'fields' ->> 'fldSVVMwQygNrpyBm' = fval;
      ELSE
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE x ->> 'id' = fval;
      END IF;
    END IF;
    RETURN jsonb_build_object('records', recs);

  ELSIF method = 'PATCH' THEN
    IF one IS NOT NULL THEN
      IF kind = 'games' THEN RETURN at.game_record(at.apply_game(one, body -> 'fields'));
      ELSIF kind = 'players' THEN RETURN at.player_record(at.apply_player(one, body -> 'fields'));
      ELSE RAISE EXCEPTION 'unsupported PATCH %', kind; END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(coalesce(body -> 'records', '[]')) LOOP
      IF kind = 'games' THEN recs := recs || jsonb_build_array(at.game_record(at.apply_game(r ->> 'id', r -> 'fields')));
      ELSIF kind = 'players' THEN recs := recs || jsonb_build_array(at.player_record(at.apply_player(r ->> 'id', r -> 'fields')));
      ELSIF kind = 'ratings' THEN out := at.upsert_rating(r -> 'fields'); IF out IS NOT NULL THEN recs := recs || jsonb_build_array(out); END IF;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('records', recs);

  ELSIF method = 'POST' THEN
    IF body ? 'fields' AND NOT (body ? 'records') THEN
      IF kind = 'games' THEN RETURN at.game_record(at.create_game(body -> 'fields'));
      ELSIF kind = 'players' THEN RETURN at.player_record(at.create_player(body -> 'fields'));
      ELSE RAISE EXCEPTION 'unsupported POST %', kind; END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(coalesce(body -> 'records', '[]')) LOOP
      IF kind = 'games' THEN recs := recs || jsonb_build_array(at.game_record(at.create_game(r -> 'fields')));
      ELSIF kind = 'players' THEN recs := recs || jsonb_build_array(at.player_record(at.create_player(r -> 'fields')));
      ELSIF kind = 'ratings' THEN out := at.upsert_rating(r -> 'fields'); IF out IS NOT NULL THEN recs := recs || jsonb_build_array(out); END IF;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('records', recs);

  ELSIF method = 'DELETE' THEN
    ids := CASE WHEN one IS NOT NULL THEN ARRAY[one]
      ELSE ARRAY(SELECT (regexp_matches(coalesce(path, ''), 'records\[\]=([^&]+)', 'g'))[1]) END;
    FOR i IN 1 .. coalesce(array_length(ids, 1), 0) LOOP
      IF kind = 'games' THEN PERFORM at.delete_game(ids[i]);
      ELSIF kind = 'ratings' THEN PERFORM at.delete_rating(ids[i]);
      ELSE RAISE EXCEPTION 'unsupported DELETE %', kind; END IF;
      recs := recs || jsonb_build_array(jsonb_build_object('id', ids[i], 'deleted', true));
    END LOOP;
    IF one IS NOT NULL THEN RETURN jsonb_build_object('id', one, 'deleted', true); END IF;
    RETURN jsonb_build_object('records', recs);
  END IF;
  RAISE EXCEPTION 'unsupported method %', method;
END $function$;

-- A member's people: their own seat, then everyone they've logged a play with (1+ plays; "Anonymous" and blanks skipped)
CREATE OR REPLACE FUNCTION bgc.refresh_member(email text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); uname text; me_name text; n_players int;
BEGIN
  SELECT bgg_username, display_name INTO uname, me_name FROM members WHERE id = mid;
  INSERT INTO players (owner_id, name, active, linked_member_id, legacy_id)
  SELECT mid, coalesce((SELECT pp.name FROM play_players pp JOIN plays p ON p.id = pp.play_id
                        WHERE p.owner_id = mid AND lower(pp.bgg_user) = lower(uname) GROUP BY pp.name ORDER BY count(*) DESC LIMIT 1), me_name),
         true, mid, at.new_key()
  WHERE NOT EXISTS (SELECT 1 FROM players WHERE owner_id = mid AND linked_member_id = mid)
  ON CONFLICT (owner_id, name) DO UPDATE SET linked_member_id = mid;
  INSERT INTO players (owner_id, name, active, legacy_id)
  SELECT mid, pp.name, sum(p.quantity) >= 10, at.new_key()
  FROM play_players pp JOIN plays p ON p.id = pp.play_id
  WHERE p.owner_id = mid AND pp.player_id IS NULL AND btrim(pp.name) <> '' AND pp.name !~* '^anonymous'
  GROUP BY pp.name
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

-- Your profile, from your own account
CREATE OR REPLACE FUNCTION bgc.my_profile(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('name', m.display_name, 'bggUsername', m.bgg_username, 'age', m.age,
    'complexity', m.complexity, 'conflict', m.conflict, 'luck', m.luck, 'tableTalk', m.table_talk, 'theme', m.theme,
    'likes', m.likes, 'dislikes', m.dislikes, 'notes', m.about)
  FROM members m WHERE m.google_email = email $$;

-- p: { bggUsername, age, complexity, conflict, luck, tableTalk, theme, likes, dislikes, notes } (already checked by the workflow)
CREATE OR REPLACE FUNCTION bgc.save_profile(email text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  UPDATE members SET
    bgg_username = nullif(p ->> 'bggUsername', ''), age = (p ->> 'age')::smallint,
    complexity = (p ->> 'complexity')::smallint, conflict = (p ->> 'conflict')::smallint, luck = (p ->> 'luck')::smallint,
    table_talk = (p ->> 'tableTalk')::smallint, theme = (p ->> 'theme')::smallint,
    likes = coalesce(p ->> 'likes', ''), dislikes = coalesce(p ->> 'dislikes', ''), about = coalesce(p ->> 'notes', ''), updated_at = now()
  WHERE google_email = email;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  RETURN jsonb_build_object('ok', true, 'profile', bgc.my_profile(email));
END $$;

-- Rate a game on any shelf you can see (gkey: that shelf's game id). Your rating is yours, wherever the copy sits.
CREATE OR REPLACE FUNCTION bgc.rate(email text, gkey text, stars numeric) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); gid bigint;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  SELECT game_id INTO gid FROM shelves WHERE legacy_id = gkey;
  IF gid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That game isn''t on a shelf'); END IF;
  IF coalesce(stars, 0) <= 0 THEN DELETE FROM ratings WHERE member_id = mid AND game_id = gid;
  ELSE
    INSERT INTO ratings (member_id, game_id, stars) VALUES (mid, gid, stars)
    ON CONFLICT (member_id, game_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now();
  END IF;
  RETURN jsonb_build_object('ok', true, 'gameId', gkey, 'stars', coalesce(stars, 0));
END $$;

-- Your own stars for the games on the shelf you're looking at (whether or not you're in that shelf's people)
CREATE OR REPLACE FUNCTION bgc.my_ratings_on(email text, oid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_object_agg(s.legacy_id, r.stars), '{}')
  FROM ratings r JOIN shelves s ON s.member_id = oid AND s.game_id = r.game_id
  WHERE r.member_id = bgc.member_id(email) $$;

-- The card made for Nathan Schmidt on Dan's shelf by a sign-in test (he isn't in Dan's plays)
DELETE FROM players pl WHERE pl.owner_id = at.admin_id() AND pl.linked_member_id = bgc.curator_id()
  AND NOT EXISTS (SELECT 1 FROM play_players pp WHERE pp.player_id = pl.id);

COMMIT;
