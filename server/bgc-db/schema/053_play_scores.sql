-- Scores on plays logged here (Dan, Oct 29): each player's score goes in with the play (p.players[].score), comes back
-- with it, and goes to BGG with it (bgg_out_next already sends play_players.score). A play's game also says whether
-- it's co-op (BGG's "Cooperative Game" mechanic), so Log a Play can mark a co-op win as everyone winning.
-- An edit that leaves a score out keeps the one the play had (a score from BGG or BG Stats isn't lost).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 053_play_scores.sql  (or bash apply.sh)
BEGIN;

-- 049's log_play, with each player's score
CREATE OR REPLACE FUNCTION bgc.log_play(email text, gkey text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); s shelves; g games; pid bigint; linked boolean; n bigint;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF nullif(gkey, '') IS NOT NULL THEN
    SELECT * INTO s FROM shelves WHERE legacy_id = gkey AND member_id = mid;
    IF s.game_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That game isn''t on your shelf'); END IF;
    SELECT * INTO g FROM games WHERE id = s.game_id;
  ELSIF (p ->> 'bggId')::int > 0 THEN
    n := bgc.catalog_game((p ->> 'bggId')::int, p ->> 'title', p ->> 'cover');
    SELECT * INTO g FROM games WHERE id = n;
    SELECT * INTO s FROM shelves WHERE member_id = mid AND (game_id = g.id OR g.bgg_id = ANY (extra_bgg_ids)) LIMIT 1;
  ELSE RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Pick a game');
  END IF;
  IF g.bgg_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Link this game to BoardGameGeek first, so the play has a game to count toward'); END IF;
  SELECT count(*) INTO n FROM plays WHERE owner_id = mid AND source = 'site' AND logged_at > now() - interval '1 day';
  IF n >= 100 THEN RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'That''s 100 plays logged today. Try again tomorrow!'); END IF;
  -- New names become people on your shelf, so they're there to pick next time
  INSERT INTO players (owner_id, name, active, legacy_id)
  SELECT mid, btrim(x ->> 'name'), true, at.new_key() FROM jsonb_array_elements(p -> 'players') x
  WHERE btrim(x ->> 'name') <> '' AND NOT EXISTS (SELECT 1 FROM players pl WHERE pl.owner_id = mid
    AND (lower(pl.name) = lower(btrim(x ->> 'name')) OR lower(btrim(x ->> 'name')) = ANY (SELECT lower(a) FROM unnest(pl.aliases) a)))
  ON CONFLICT (owner_id, name) DO NOTHING;
  INSERT INTO plays (owner_id, bgg_play_id, played_on, game_id, bgg_id, game_name, quantity, minutes, location, comments, source, logged_at)
  VALUES (mid, NULL, (p ->> 'date')::date, g.id, g.bgg_id, g.title, 1, nullif((p ->> 'minutes')::int, 0), coalesce(btrim(p ->> 'location'), ''), coalesce(p ->> 'comments', ''), 'site', now())
  RETURNING id INTO pid;
  INSERT INTO play_players (play_id, seat, player_id, name, bgg_user, win, score, is_new)
  SELECT pid, x.n, pl.id, btrim(x.v ->> 'name'),
    coalesce(nullif(pl.bgg_username, ''), (SELECT m.bgg_username FROM members m WHERE m.id = pl.linked_member_id), ''),
    coalesce((x.v ->> 'win')::boolean, false), left(coalesce(btrim(x.v ->> 'score'), ''), 20), false
  FROM jsonb_array_elements(p -> 'players') WITH ORDINALITY x(v, n)
  LEFT JOIN LATERAL (SELECT * FROM players pl WHERE pl.owner_id = mid AND (lower(pl.name) = lower(btrim(x.v ->> 'name'))
    OR lower(btrim(x.v ->> 'name')) = ANY (SELECT lower(a) FROM unnest(pl.aliases) a)) ORDER BY pl.id LIMIT 1) pl ON true
  WHERE btrim(x.v ->> 'name') <> '';
  IF s.game_id IS NOT NULL THEN PERFORM bgc.recount_shelf_game(mid, s.game_id); END IF;
  linked := EXISTS (SELECT 1 FROM bgg_links WHERE member_id = mid AND send_plays);
  IF linked THEN INSERT INTO bgg_outbox (member_id, kind, bgg_id, play_id) VALUES (mid, 'play', g.bgg_id, pid); END IF;
  RETURN jsonb_build_object('ok', true, 'playId', pid, 'gameId', s.legacy_id, 'toBgg', linked,
    'playCount', (SELECT play_count FROM shelves WHERE member_id = mid AND game_id = s.game_id),
    'lastPlayed', (SELECT last_played FROM shelves WHERE member_id = mid AND game_id = s.game_id));
END $$;

-- 049's my_plays, with scores and co-op
CREATE OR REPLACE FUNCTION bgc.my_plays(email text, skip int, lim int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS mid),
  page AS (
    SELECT p.* FROM plays p, me WHERE p.owner_id = me.mid
    ORDER BY p.played_on DESC NULLS LAST, p.id DESC OFFSET greatest(coalesce(skip, 0), 0) LIMIT least(greatest(coalesce(lim, 50), 1), 200))
  SELECT jsonb_build_object('ok', true,
    'total', (SELECT count(*) FROM plays, me WHERE owner_id = me.mid),
    'linked', EXISTS (SELECT 1 FROM bgg_links l, me WHERE l.member_id = me.mid),
    -- the last sync from BGG (the Sync button and the nightly run): { state: running | done | error, finished, message }
    'sync', (SELECT m.import_status FROM members m, me WHERE m.id = me.mid),
    'bggUsername', (SELECT coalesce(l.bgg_username::text, m.bgg_username) FROM members m LEFT JOIN bgg_links l ON l.member_id = m.id, me WHERE m.id = me.mid),
    'plays', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'date', p.played_on, 'bggId', p.bgg_id, 'title', coalesce(g.title, p.game_name),
      'cover', g.cover_card, 'icon', g.icon, 'minutes', p.minutes, 'quantity', p.quantity, 'location', p.location, 'comments', p.comments, 'source', p.source,
      'coop', coalesce('Cooperative Game' = ANY (g.mechanics), false),
      'onBgg', p.bgg_play_id IS NOT NULL,
      'sending', EXISTS (SELECT 1 FROM bgg_outbox o WHERE o.play_id = p.id AND o.state = 'pending'),
      'shelfId', (SELECT s.legacy_id FROM shelves s, me WHERE s.member_id = me.mid AND (s.game_id = p.game_id OR p.bgg_id = ANY (s.extra_bgg_ids)) LIMIT 1),
      'players', coalesce((SELECT jsonb_agg(jsonb_build_object('name', coalesce(q.name, pp.name), 'win', pp.win, 'score', pp.score) ORDER BY pp.seat)
        FROM play_players pp LEFT JOIN players q ON q.id = pp.player_id WHERE pp.play_id = p.id), '[]'))
      ORDER BY p.played_on DESC NULLS LAST, p.id DESC) FROM page p LEFT JOIN games g ON g.id = p.game_id), '[]')) $$;

-- 050's play_get, with scores and co-op
CREATE OR REPLACE FUNCTION bgc.play_get(email text, pid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p.id IS NULL THEN jsonb_build_object('ok', false, 'status', 404, 'message', 'That play isn''t yours, or is gone') ELSE
    jsonb_build_object('ok', true, 'play', jsonb_build_object('id', p.id, 'date', p.played_on, 'bggId', p.bgg_id, 'title', coalesce(g.title, p.game_name),
      'cover', g.cover_card, 'minutes', p.minutes, 'location', p.location, 'comments', p.comments, 'source', p.source, 'onBgg', p.bgg_play_id IS NOT NULL,
      'coop', coalesce('Cooperative Game' = ANY (g.mechanics), false),
      'editable', p.bgg_play_id IS NULL OR EXISTS (SELECT 1 FROM bgg_links WHERE member_id = p.owner_id AND send_plays),
      'shelfId', (SELECT s.legacy_id FROM shelves s WHERE s.member_id = p.owner_id AND (s.game_id = p.game_id OR p.bgg_id = ANY (s.extra_bgg_ids)) LIMIT 1),
      'players', coalesce((SELECT jsonb_agg(jsonb_build_object('name', coalesce(q.name, pp.name), 'win', pp.win, 'score', pp.score) ORDER BY pp.seat)
        FROM play_players pp LEFT JOIN players q ON q.id = pp.player_id WHERE pp.play_id = p.id), '[]'))) END
  FROM (SELECT bgc.member_id(email) AS mid) me LEFT JOIN plays p ON p.id = pid AND p.owner_id = me.mid LEFT JOIN games g ON g.id = p.game_id $$;

-- 050's play_edit: a score given replaces the old one; none given keeps it
CREATE OR REPLACE FUNCTION bgc.play_edit(email text, pid bigint, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); pl plays; linked boolean; gid bigint;
BEGIN
  SELECT * INTO pl FROM plays WHERE id = pid AND owner_id = mid;
  IF pl.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That play isn''t yours, or is gone'); END IF;
  linked := EXISTS (SELECT 1 FROM bgg_links WHERE member_id = mid AND send_plays);
  IF pl.bgg_play_id IS NOT NULL AND NOT linked THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'message', 'That play is on BGG, so the next sync would put it back. Change it on BGG (or BG Stats), or link BGG in My profile and change it here.');
  END IF;
  INSERT INTO players (owner_id, name, active, legacy_id)
  SELECT mid, btrim(x ->> 'name'), true, at.new_key() FROM jsonb_array_elements(p -> 'players') x
  WHERE btrim(x ->> 'name') <> '' AND NOT EXISTS (SELECT 1 FROM players q WHERE q.owner_id = mid
    AND (lower(q.name) = lower(btrim(x ->> 'name')) OR lower(btrim(x ->> 'name')) = ANY (SELECT lower(a) FROM unnest(q.aliases) a)))
  ON CONFLICT (owner_id, name) DO NOTHING;
  UPDATE plays SET played_on = (p ->> 'date')::date, minutes = nullif((p ->> 'minutes')::int, 0), location = coalesce(btrim(p ->> 'location'), ''),
    comments = coalesce(p ->> 'comments', '') WHERE id = pid;
  -- What only BGG/BG Stats records about each seat (color, start, their rating; the score unless one is given) stays with the person
  CREATE TEMP TABLE IF NOT EXISTS old_seats ON COMMIT DROP AS SELECT * FROM play_players WITH NO DATA;
  DELETE FROM old_seats;
  INSERT INTO old_seats SELECT * FROM play_players WHERE play_id = pid;
  DELETE FROM play_players WHERE play_id = pid;
  INSERT INTO play_players (play_id, seat, player_id, name, bgg_user, win, score, is_new, color, start_position, rating)
  SELECT pid, x.n, q.id, btrim(x.v ->> 'name'),
    coalesce(nullif(q.bgg_username, ''), (SELECT m.bgg_username FROM members m WHERE m.id = q.linked_member_id), o.bgg_user, ''),
    coalesce((x.v ->> 'win')::boolean, false), left(coalesce(btrim(x.v ->> 'score'), o.score, ''), 20), coalesce(o.is_new, false),
    coalesce(o.color, ''), coalesce(o.start_position, ''), coalesce(o.rating, '')
  FROM jsonb_array_elements(p -> 'players') WITH ORDINALITY x(v, n)
  LEFT JOIN LATERAL (SELECT * FROM players q WHERE q.owner_id = mid AND (lower(q.name) = lower(btrim(x.v ->> 'name'))
    OR lower(btrim(x.v ->> 'name')) = ANY (SELECT lower(a) FROM unnest(q.aliases) a)) ORDER BY q.id LIMIT 1) q ON true
  LEFT JOIN LATERAL (SELECT * FROM old_seats o WHERE (o.player_id IS NOT NULL AND o.player_id = q.id) OR lower(o.name) = lower(btrim(x.v ->> 'name')) LIMIT 1) o ON true
  WHERE btrim(x.v ->> 'name') <> '';
  FOR gid IN SELECT s.game_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = mid AND (g.bgg_id = pl.bgg_id OR pl.bgg_id = ANY (s.extra_bgg_ids)) LOOP
    PERFORM bgc.recount_shelf_game(mid, gid);
  END LOOP;
  -- To BGG: a play already there is changed there; one waiting to go simply goes as it is now; one not sent yet is sent
  IF linked AND NOT EXISTS (SELECT 1 FROM bgg_outbox WHERE play_id = pid AND state = 'pending') THEN
    INSERT INTO bgg_outbox (member_id, kind, bgg_id, play_id, want) VALUES (mid, 'play', pl.bgg_id, pid, CASE WHEN pl.bgg_play_id IS NOT NULL THEN '{"edit": true}'::jsonb ELSE '{}'::jsonb END);
  END IF;
  RETURN jsonb_build_object('ok', true, 'toBgg', linked) || bgc.play_get(email, pid);
END $$;

COMMIT;
