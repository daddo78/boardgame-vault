-- Where you played stays yours (Dan, Oct 26). BG Stats posts every location to BGG as an initial ("H." for Home and for
-- Haworth alike), and anything on BGG can be read by anyone, so:
--   - the nightly sync no longer brings BGG's location in as the play's place: it's kept apart, as plays.bgg_location,
--     only to be sent back unchanged when a play is edited here (so the site never changes BGG data you didn't touch)
--   - places come from plays logged or edited here, and go to BGG only with the new switch send_location (off unless
--     the member turns it on: on BGG anyone can read them)
--   - the places already brought in from BGG move to bgg_location (plays logged here keep theirs)
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 052_private_places.sql  (or bash apply.sh)
BEGIN;

ALTER TABLE plays ADD COLUMN IF NOT EXISTS bgg_location text NOT NULL DEFAULT '';
ALTER TABLE bgg_links ADD COLUMN IF NOT EXISTS send_location boolean NOT NULL DEFAULT false;

-- What BGG gave as the place is BGG's; the place here starts empty for those plays
UPDATE plays SET bgg_location = location, location = '' WHERE source = 'bgg' AND location <> '';
-- (a play sent from here kept its own place; BGG has what we sent, or nothing)

-- 049's save: BGG's location goes to bgg_location, never to the place
CREATE OR REPLACE FUNCTION at.save_plays(owner_email text, plays jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  oid bigint; p jsonb; v_play bigint; v_inserted boolean; n_new int := 0; n_all int := 0;
BEGIN
  SELECT id INTO oid FROM members WHERE google_email = owner_email;
  IF oid IS NULL THEN RAISE EXCEPTION 'no member %', owner_email; END IF;
  INSERT INTO games (bgg_id, title)
    SELECT DISTINCT ON ((x ->> 'bggId')::int) (x ->> 'bggId')::int, coalesce(nullif(x ->> 'gameName', ''), 'BGG #' || (x ->> 'bggId'))
    FROM jsonb_array_elements(plays) x WHERE (x ->> 'bggId')::int > 0
    ON CONFLICT (bgg_id) DO NOTHING;
  FOR p IN SELECT * FROM jsonb_array_elements(plays) LOOP
    n_all := n_all + 1;
    INSERT INTO plays (owner_id, bgg_play_id, played_on, game_id, bgg_id, game_name, quantity, minutes, bgg_location, comments, incomplete)
    VALUES (oid, (p ->> 'id')::bigint, nullif(nullif(p ->> 'date', ''), '0000-00-00')::date, (SELECT id FROM games WHERE bgg_id = (p ->> 'bggId')::int),
      (p ->> 'bggId')::int, coalesce(p ->> 'gameName', ''), coalesce((p ->> 'quantity')::int, 1), nullif((p ->> 'minutes')::int, 0),
      coalesce(p ->> 'location', ''), coalesce(p ->> 'comments', ''), coalesce((p ->> 'incomplete')::boolean, false))
    ON CONFLICT (owner_id, bgg_play_id) DO UPDATE SET played_on = EXCLUDED.played_on, game_id = EXCLUDED.game_id, bgg_id = EXCLUDED.bgg_id,
      game_name = EXCLUDED.game_name, quantity = EXCLUDED.quantity, minutes = EXCLUDED.minutes, bgg_location = EXCLUDED.bgg_location,
      comments = EXCLUDED.comments, incomplete = EXCLUDED.incomplete
    RETURNING id, (xmax = 0) INTO v_play, v_inserted;
    IF v_inserted THEN n_new := n_new + 1; END IF;
    DELETE FROM play_players WHERE play_players.play_id = v_play;
    INSERT INTO play_players (play_id, seat, player_id, name, bgg_user, win, score, is_new, color, start_position, rating)
    SELECT v_play, (x ->> 'seat')::smallint,
      (SELECT pl.id FROM players pl WHERE pl.owner_id = oid AND (lower(pl.name) = lower(x ->> 'name') OR lower(x ->> 'name') = ANY (SELECT lower(a) FROM unnest(pl.aliases) a)) LIMIT 1),
      coalesce(x ->> 'name', ''), coalesce(x ->> 'user', ''), coalesce((x ->> 'win')::boolean, false), coalesce(x ->> 'score', ''), coalesce((x ->> 'isNew')::boolean, false),
      coalesce(x ->> 'color', ''), coalesce(x ->> 'position', ''), coalesce(x ->> 'rating', '')
    FROM jsonb_array_elements(p -> 'players') x;
  END LOOP;
  -- Seats whose name now matches a player (e.g. a player card added since) get linked
  UPDATE play_players pp SET player_id = pl.id
  FROM plays pg, players pl
  WHERE pp.play_id = pg.id AND pg.owner_id = oid AND pp.player_id IS NULL AND pl.owner_id = oid
    AND (lower(pl.name) = lower(pp.name) OR lower(pp.name) = ANY (SELECT lower(a) FROM unnest(pl.aliases) a));
  RETURN jsonb_build_object('plays', n_all, 'newPlays', n_new);
END $$;

-- 049's outbox read: a play goes out with its place only when the member sends places; else with BGG's own, unchanged
CREATE OR REPLACE FUNCTION bgc.bgg_out_next(lim int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'id')::bigint), '[]') FROM (
    SELECT jsonb_build_object('id', o.id, 'memberId', o.member_id, 'kind', o.kind, 'bggId', o.bgg_id, 'want', o.want, 'tries', o.tries,
      'username', l.bgg_username::text, 'sealed', l.token_sealed,
      'known', (SELECT jsonb_build_object('collId', i.coll_id, 'own', i.own, 'prevowned', i.prevowned, 'wishlist', i.wishlist, 'rating10', i.rating10, 'sentAt', at.iso(i.sent_at))
        FROM bgg_items i WHERE i.member_id = o.member_id AND i.bgg_id = o.bgg_id AND o.kind = 'item' AND i.sent_at > now() - interval '6 hours'),
      'play', CASE WHEN o.kind = 'play' THEN (SELECT jsonb_build_object('id', p.id, 'bggPlayId', p.bgg_play_id, 'date', p.played_on, 'minutes', p.minutes,
        'quantity', p.quantity, 'location', CASE WHEN l.send_location THEN p.location ELSE p.bgg_location END, 'comments', p.comments,
        'players', coalesce((SELECT jsonb_agg(jsonb_build_object('name', pp.name, 'username', pp.bgg_user, 'win', pp.win, 'score', pp.score, 'isNew', pp.is_new,
          'color', pp.color, 'position', pp.start_position, 'rating', pp.rating) ORDER BY pp.seat)
          FROM play_players pp WHERE pp.play_id = p.id), '[]')) FROM plays p WHERE p.id = o.play_id) END) AS x
    FROM bgg_outbox o JOIN bgg_links l ON l.member_id = o.member_id AND l.state = 'ok'
    WHERE o.state = 'pending' AND o.next_try_at <= now()
    ORDER BY o.id LIMIT lim) q $$;

CREATE OR REPLACE FUNCTION bgc.bgg_link_status(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('linked', l.member_id IS NOT NULL, 'username', coalesce(l.bgg_username::text, m.bgg_username),
    'state', l.state, 'lastSent', at.iso(l.last_sent_at), 'expires', at.iso(l.expires_at),
    'plays', coalesce(l.send_plays, true), 'collection', coalesce(l.send_collection, true), 'ratings', coalesce(l.send_ratings, true), 'location', coalesce(l.send_location, false),
    'waiting', (SELECT count(*) FROM bgg_outbox o WHERE o.member_id = m.id AND o.state = 'pending'),
    'failed', (SELECT count(*) FROM bgg_outbox o WHERE o.member_id = m.id AND o.state = 'failed' AND o.done_at > now() - interval '7 days'))
  FROM members m LEFT JOIN bgg_links l ON l.member_id = m.id WHERE m.google_email = email $$;

CREATE OR REPLACE FUNCTION bgc.bgg_link_settings(email text, s jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email);
BEGIN
  UPDATE bgg_links SET send_plays = coalesce((s ->> 'plays')::boolean, send_plays), send_collection = coalesce((s ->> 'collection')::boolean, send_collection),
    send_ratings = coalesce((s ->> 'ratings')::boolean, send_ratings),
    send_location = coalesce((s ->> 'location')::boolean, send_location) WHERE member_id = mid;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'Link BGG first'); END IF;
  UPDATE bgg_outbox o SET state = 'skipped', error = 'switched off', done_at = now() FROM bgg_links l
  WHERE o.member_id = mid AND l.member_id = mid AND o.state = 'pending' AND o.kind = 'play' AND NOT l.send_plays;
  UPDATE bgg_outbox o SET want = o.want - (CASE WHEN l.send_collection THEN '{}'::text[] ELSE ARRAY['own', 'wishlist'] END)
    - (CASE WHEN l.send_ratings THEN '{}'::text[] ELSE ARRAY['rating10'] END)
  FROM bgg_links l WHERE o.member_id = mid AND l.member_id = mid AND o.state = 'pending' AND o.kind = 'item';
  UPDATE bgg_outbox SET state = 'skipped', error = 'switched off', done_at = now() WHERE member_id = mid AND state = 'pending' AND kind = 'item' AND want = '{}';
  IF (s ->> 'plays')::boolean THEN PERFORM bgc.bgg_queue_unsent_plays(mid); END IF; -- switched back on: catch up
  RETURN jsonb_build_object('ok', true, 'link', bgc.bgg_link_status(email));
END $$;

-- 049's merge: a play logged here and also on BGG keeps the place you gave it
CREATE OR REPLACE FUNCTION bgc.merge_site_plays(email text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); n int;
BEGIN
  WITH who AS (
    SELECT p.id, p.bgg_id, p.played_on, p.source, p.bgg_play_id,
      coalesce((SELECT string_agg(lower(btrim(pp.name)), ',' ORDER BY lower(btrim(pp.name))) FROM play_players pp WHERE pp.play_id = p.id), '') AS names
    FROM plays p WHERE p.owner_id = mid AND p.played_on IS NOT NULL
      AND (p.bgg_play_id IS NULL OR p.source = 'bgg')),
  ours AS (SELECT id, bgg_id, played_on, names, row_number() OVER (PARTITION BY bgg_id, played_on, names ORDER BY id) AS k FROM who WHERE bgg_play_id IS NULL),
  theirs AS (SELECT bgg_id, played_on, names, count(*) AS c FROM who WHERE source = 'bgg' GROUP BY 1, 2, 3),
  dupes AS (SELECT o.id, o.bgg_id, o.played_on, o.names FROM ours o JOIN theirs t USING (bgg_id, played_on, names) WHERE o.k <= t.c),
  -- the place you gave it here goes to the BGG copy (BGG's own place never comes in)
  keep AS (UPDATE plays b SET location = s.location FROM dupes d JOIN plays s ON s.id = d.id, who w
           WHERE w.id = b.id AND w.source = 'bgg' AND w.bgg_id = d.bgg_id AND w.played_on = d.played_on AND w.names = d.names
             AND b.location = '' AND s.location <> '' RETURNING b.id)
  DELETE FROM plays p USING dupes d WHERE p.id = d.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM bgc.refresh_member(email); END IF;
  RETURN n;
END $$;

COMMIT;
