-- My stats (Dan, Oct 26): a member's play history, the people they play with and how they do against them, where they
-- play, and some fun facts, for the "My stats" page. All from their own plays (BGG's, BG Stats', and the ones logged
-- here). "You" in a play is your own seat: the player linked to your account.
--   bgc.my_stats(email, yr)   yr: one calendar year, or null for all time
-- Removing one of your people who has plays hides them (players.hidden): off your list and Log a Play's search, while
-- your plays keep who was there (and the nightly sync, finding them, doesn't add them back). Adding them again unhides.
-- And a place can be cleared from your plays (bgc.place_clear): the name goes into a nameless places row, whose old
-- names bgc.apply_place_aliases (050) turns into no place at all, so the nightly sync doesn't bring it back.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 051_my_stats.sql  (or bash apply.sh)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.my_stats(email text, yr int) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE mid bigint := bgc.member_id(email); me bigint; d0 date; d1 date; res jsonb;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  SELECT id INTO me FROM players WHERE owner_id = mid AND linked_member_id = mid ORDER BY id LIMIT 1;
  d0 := CASE WHEN yr IS NULL THEN DATE '1900-01-01' ELSE make_date(yr, 1, 1) END;
  d1 := CASE WHEN yr IS NULL THEN current_date ELSE least(make_date(yr, 12, 31), current_date) END;

  WITH p AS (  -- the plays in range, each with its game and whether you were in it and won
    SELECT pl.id, pl.played_on AS d, greatest(pl.quantity, 1) AS q, pl.minutes, btrim(pl.location) AS loc, pl.bgg_id,
      coalesce(g.title, pl.game_name) AS title, g.cover_card AS cover, g.icon, g.weight,
      -- how long it took: as logged, or else the box's time (the middle of its range)
      coalesce(nullif(pl.minutes, 0), round((coalesce(g.min_time, g.max_time) + coalesce(g.max_time, g.min_time)) / 2.0)) AS est,
      EXISTS (SELECT 1 FROM play_players x WHERE x.play_id = pl.id AND x.player_id = me) AS mine,
      EXISTS (SELECT 1 FROM play_players x WHERE x.play_id = pl.id AND x.player_id = me AND x.win) AS iwon,
      EXISTS (SELECT 1 FROM play_players x WHERE x.play_id = pl.id AND x.win) AS haswin,
      (SELECT count(*) FROM play_players x WHERE x.play_id = pl.id) AS seats
    FROM plays pl LEFT JOIN games g ON g.id = pl.game_id
    WHERE pl.owner_id = mid AND pl.played_on BETWEEN d0 AND d1),
  days AS (SELECT d, sum(q)::int AS n, count(DISTINCT bgg_id)::int AS games FROM p GROUP BY d),
  -- Weeks with at least one play, as islands of consecutive weeks (Monday-based)
  wk AS (SELECT DISTINCT date_trunc('week', played_on)::date AS w FROM plays WHERE owner_id = mid AND played_on IS NOT NULL),
  isl AS (SELECT w, w - (row_number() OVER (ORDER BY w) * 7)::int AS k FROM wk),
  runs AS (SELECT min(w) AS a, max(w) AS b, count(*)::int AS n FROM isl GROUP BY k),
  gamesall AS (SELECT bgg_id, min(played_on) AS first FROM plays WHERE owner_id = mid AND played_on IS NOT NULL GROUP BY bgg_id),
  top AS (SELECT bgg_id, min(title) AS title, min(cover) AS cover, min(icon) AS icon, sum(q)::int AS n, max(d) AS last,
            count(*) FILTER (WHERE iwon)::int AS wins, count(*) FILTER (WHERE mine AND haswin)::int AS decided
          FROM p GROUP BY bgg_id),
  -- Everyone else at your table: plays together, and when one of you won, who
  seat AS (SELECT p.id, p.q, p.iwon, p.haswin, p.loc, coalesce(q.name, x.name) AS who, x.win AS theywon
           FROM p JOIN play_players x ON x.play_id = p.id LEFT JOIN players q ON q.id = x.player_id
           WHERE p.mine AND x.player_id IS DISTINCT FROM me AND btrim(x.name) <> '' AND x.name !~* '^anonymous'),
  ppl AS (SELECT who, sum(q)::int AS n, count(*) FILTER (WHERE iwon)::int AS mywins, count(*) FILTER (WHERE theywon)::int AS theirwins,
            count(*) FILTER (WHERE haswin)::int AS decided FROM seat GROUP BY who),
  gaps AS (SELECT d, lag(d) OVER (ORDER BY d) AS prev FROM days),
  places AS (SELECT loc, sum(q)::int AS n, count(*) FILTER (WHERE iwon)::int AS wins, count(*) FILTER (WHERE mine AND haswin)::int AS decided
             FROM p WHERE loc <> '' GROUP BY loc)
  SELECT jsonb_build_object('ok', true, 'year', yr,
    'years', (SELECT coalesce(jsonb_agg(y ORDER BY y DESC), '[]') FROM (SELECT DISTINCT extract(year FROM played_on)::int AS y FROM plays WHERE owner_id = mid AND played_on IS NOT NULL) yy),
    'totals', (SELECT jsonb_build_object('plays', coalesce(sum(q), 0)::int, 'games', count(DISTINCT bgg_id), 'days', count(DISTINCT d),
        'minutes', coalesce(sum(minutes * q) FILTER (WHERE minutes > 0), 0)::int, 'timed', count(*) FILTER (WHERE minutes > 0),
        'estMinutes', coalesce(sum(est * q), 0)::int,
        'withMe', count(*) FILTER (WHERE mine), 'wins', count(*) FILTER (WHERE iwon), 'decided', count(*) FILTER (WHERE mine AND haswin),
        'solo', count(*) FILTER (WHERE seats = 1), 'avgSeats', round(avg(seats) FILTER (WHERE seats > 0), 1),
        'avgWeight', round(avg(weight) FILTER (WHERE weight > 0), 2), 'first', min(d), 'last', max(d)) FROM p),
    -- Plays per month: the year's 12, or the last 24 for all time
    'months', (SELECT coalesce(jsonb_agg(jsonb_build_object('m', to_char(m, 'YYYY-MM'), 'n', coalesce(x.n, 0)) ORDER BY m), '[]')
      FROM generate_series(CASE WHEN yr IS NULL THEN date_trunc('month', current_date) - interval '23 months' ELSE make_date(yr, 1, 1) END,
                           CASE WHEN yr IS NULL THEN date_trunc('month', current_date) ELSE make_date(yr, 12, 1) END, interval '1 month') m
      LEFT JOIN (SELECT date_trunc('month', d) AS mm, sum(q)::int AS n FROM p GROUP BY 1) x ON x.mm = m),
    -- Every day with plays in the calendar's year (this one for all time)
    'calendar', (SELECT coalesce(jsonb_agg(jsonb_build_object('d', d, 'n', n) ORDER BY d), '[]') FROM days
      WHERE d >= CASE WHEN yr IS NULL THEN current_date - 364 ELSE make_date(yr, 1, 1) END),
    'weekdays', (SELECT jsonb_agg(coalesce(x.n, 0) ORDER BY w) FROM generate_series(1, 7) w
      LEFT JOIN (SELECT extract(isodow FROM d)::int AS dw, sum(q)::int AS n FROM p GROUP BY 1) x ON x.dw = w),
    'streak', jsonb_build_object(
      'current', coalesce((SELECT n FROM runs WHERE b >= date_trunc('week', current_date)::date - 7 ORDER BY b DESC LIMIT 1), 0),
      'longest', coalesce((SELECT jsonb_build_object('weeks', n, 'from', a, 'to', b + 6) FROM runs ORDER BY n DESC, b DESC LIMIT 1), 'null')),
    'topGames', (SELECT coalesce(jsonb_agg(jsonb_build_object('bggId', bgg_id, 'title', title, 'cover', cover, 'icon', icon, 'n', n, 'last', last, 'wins', wins, 'decided', decided)
      ORDER BY n DESC, last DESC), '[]') FROM (SELECT * FROM top ORDER BY n DESC, last DESC LIMIT 10) t),
    -- n games played at least n times
    'hIndex', (SELECT coalesce(max(k), 0) FROM (SELECT row_number() OVER (ORDER BY n DESC) AS k, n FROM top) h WHERE n >= k),
    'newGames', (SELECT jsonb_build_object('count', count(*), 'recent', coalesce(jsonb_agg(jsonb_build_object('title', t.title, 'cover', t.cover, 'first', a.first) ORDER BY a.first DESC)
        FILTER (WHERE a.first IS NOT NULL), '[]'))
      FROM gamesall a JOIN top t USING (bgg_id) WHERE a.first BETWEEN d0 AND d1),
    -- On your shelf, and not played in a year (or ever)
    'dusty', (SELECT jsonb_build_object('count', count(*), 'games', coalesce(jsonb_agg(jsonb_build_object('title', g.title, 'cover', g.cover_card, 'last', s.last_played)
        ORDER BY s.last_played NULLS FIRST) FILTER (WHERE rn <= 6), '[]'))
      FROM (SELECT s.*, row_number() OVER (ORDER BY s.last_played NULLS FIRST, s.game_id) AS rn FROM shelves s
            WHERE s.member_id = mid AND (s.last_played IS NULL OR s.last_played < current_date - 365)) s JOIN games g ON g.id = s.game_id),
    'people', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', who, 'n', n, 'myWins', mywins, 'theirWins', theirwins, 'decided', decided) ORDER BY n DESC, who), '[]')
      FROM (SELECT * FROM ppl ORDER BY n DESC, who LIMIT 12) x),
    -- Who beats you most often, and whom you beat most often (at least 5 decided games together)
    'nemesis', (SELECT jsonb_build_object('name', who, 'theirWins', theirwins, 'decided', decided) FROM ppl WHERE decided >= 5 AND theirwins > mywins
      ORDER BY theirwins::numeric / decided DESC, decided DESC LIMIT 1),
    'victim', (SELECT jsonb_build_object('name', who, 'myWins', mywins, 'decided', decided) FROM ppl WHERE decided >= 5 AND mywins > theirwins
      ORDER BY mywins::numeric / decided DESC, decided DESC LIMIT 1),
    'places', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', loc, 'n', n, 'wins', wins, 'decided', decided) ORDER BY n DESC, loc), '[]')
      FROM (SELECT * FROM places ORDER BY n DESC, loc LIMIT 8) x),
    'facts', jsonb_build_object(
      'busiest', (SELECT jsonb_build_object('d', d, 'n', n, 'games', games) FROM days ORDER BY n DESC, d DESC LIMIT 1),
      'longestGap', (SELECT jsonb_build_object('from', prev, 'to', d, 'days', d - prev) FROM gaps WHERE prev IS NOT NULL ORDER BY d - prev DESC, d DESC LIMIT 1),
      'firstEver', (SELECT jsonb_build_object('d', pl.played_on, 'title', coalesce(g.title, pl.game_name)) FROM plays pl LEFT JOIN games g ON g.id = pl.game_id
        WHERE pl.owner_id = mid AND pl.played_on IS NOT NULL ORDER BY pl.played_on, pl.id LIMIT 1),
      'marathon', (SELECT jsonb_build_object('title', title, 'd', d, 'n', n) FROM (SELECT title, d, sum(q)::int AS n FROM p GROUP BY title, d) x WHERE n > 1 ORDER BY n DESC, d DESC LIMIT 1),
      'longest', (SELECT jsonb_build_object('title', title, 'd', d, 'minutes', minutes) FROM p WHERE minutes > 0 ORDER BY minutes DESC, d DESC LIMIT 1)))
  INTO res;
  RETURN res;
END $$;

-- Take a place off every play of yours that has it (and off your list). Remembered in the nameless row, so a play
-- synced from BGG with that place loses it again.
CREATE OR REPLACE FUNCTION bgc.place_clear(email text, place text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); nm text := btrim(coalesce(place, '')); n int;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF nm = '' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Which place?'); END IF;
  DELETE FROM places WHERE member_id = mid AND lower(name) = lower(nm);
  INSERT INTO places (member_id, name, aliases) VALUES (mid, '', ARRAY[nm])
  ON CONFLICT (member_id, lower(name)) DO UPDATE SET aliases = ARRAY(SELECT DISTINCT x FROM unnest(places.aliases || EXCLUDED.aliases) x);
  n := bgc.apply_place_aliases(email);
  RETURN jsonb_build_object('ok', true, 'cleared', n) || bgc.my_places(email);
END $$;

-- 050's list and merge, now leaving out the nameless row (where cleared places are remembered)
CREATE OR REPLACE FUNCTION bgc.my_places(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS mid),
  used AS (SELECT lower(btrim(location)) AS k, min(btrim(location)) AS name, sum(quantity)::int AS plays, max(played_on) AS last
           FROM plays, me WHERE owner_id = me.mid AND btrim(location) <> '' GROUP BY 1),
  saved AS (SELECT lower(name) AS k, name FROM places, me WHERE member_id = me.mid AND name <> '')
  SELECT jsonb_build_object('ok', true, 'places', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', coalesce(s.name, u.name), 'saved', s.k IS NOT NULL,
    'plays', coalesce(u.plays, 0), 'last', u.last)) ORDER BY s.k IS NULL, u.last DESC NULLS LAST, coalesce(s.name, u.name)), '[]'))
  FROM saved s FULL JOIN used u ON u.k = s.k $$;

ALTER TABLE players ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;

-- 050's list, without the people you hid
CREATE OR REPLACE FUNCTION bgc.my_people(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS mid, bgc.is_admin(email) AND bgc.member_id(email) = at.admin_id() AS emails)
  SELECT jsonb_build_object('ok', true, 'people', coalesce(jsonb_agg(x ORDER BY (x ->> 'active')::boolean DESC, (x ->> 'plays')::int DESC, x ->> 'name'), '[]'))
  FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object('id', p.legacy_id, 'name', p.name, 'aliases', to_jsonb(p.aliases), 'active', p.active,
      'bggUsername', coalesce(nullif(p.bgg_username, ''), m.bgg_username), 'member', m.id IS NOT NULL, 'me', p.linked_member_id = me.mid,
      'googleEmail', CASE WHEN me.emails THEN m.google_email::text END,
      'plays', coalesce(c.plays, 0), 'games', coalesce(c.games, 0), 'last', c.last)) AS x
    FROM me JOIN players p ON p.owner_id = me.mid AND NOT p.hidden
    LEFT JOIN members m ON m.id = p.linked_member_id
    LEFT JOIN LATERAL (SELECT sum(pl.quantity)::int AS plays, count(DISTINCT pl.bgg_id)::int AS games, max(pl.played_on) AS last
      FROM play_players pp JOIN plays pl ON pl.id = pp.play_id WHERE pp.player_id = p.id) c ON true) q $$;

-- 050's save: the same, and adding a hidden name brings that person back
CREATE OR REPLACE FUNCTION bgc.person_save(email text, pkey text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); r players; back text; nm text := btrim(coalesce(p ->> 'name', ''));
  al text[] := ARRAY(SELECT DISTINCT btrim(a) FROM jsonb_array_elements_text(coalesce(p -> 'aliases', '[]')) a WHERE btrim(a) <> '' AND lower(btrim(a)) <> lower(btrim(coalesce(p ->> 'name', ''))));
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF nm = '' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Give them a name'); END IF;
  -- Adding someone you hid brings them back, plays and all
  IF nullif(pkey, '') IS NULL THEN
    UPDATE players SET hidden = false, active = true WHERE owner_id = mid AND hidden AND lower(name) = lower(nm) RETURNING legacy_id, name INTO pkey, back;
    nm := coalesce(back, nm); -- their name as it was
  END IF;
  IF EXISTS (SELECT 1 FROM players WHERE owner_id = mid AND lower(name) = lower(nm) AND legacy_id IS DISTINCT FROM nullif(pkey, '')) THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'message', nm || ' is already one of your people');
  END IF;
  IF nullif(pkey, '') IS NULL THEN
    INSERT INTO players (owner_id, name, aliases, active, bgg_username, legacy_id)
    VALUES (mid, nm, al, coalesce((p ->> 'active')::boolean, true), nullif(btrim(p ->> 'bggUsername'), ''), at.new_key()) RETURNING * INTO r;
  ELSE
    UPDATE players SET name = nm, aliases = al, active = coalesce((p ->> 'active')::boolean, active),
      bgg_username = CASE WHEN p ? 'bggUsername' THEN nullif(btrim(p ->> 'bggUsername'), '') ELSE bgg_username END, updated_at = now()
    WHERE owner_id = mid AND legacy_id = pkey RETURNING * INTO r;
    IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That person isn''t in your list'); END IF;
  END IF;
  -- An admin, on their own shelf, can still let someone in by Google email (the Players screen's old job, at.apply_player)
  IF p ? 'googleEmail' AND bgc.is_admin(email) AND mid = at.admin_id() THEN PERFORM at.apply_player(r.legacy_id, jsonb_build_object('fldnwPL9Z33JcXoj2', p ->> 'googleEmail')); END IF;
  -- Seats in your plays that carry this name (or one of the other names) belong to them now
  UPDATE play_players pp SET player_id = r.id FROM plays pl
  WHERE pp.play_id = pl.id AND pl.owner_id = mid AND pp.player_id IS NULL AND (lower(pp.name) = lower(r.name) OR lower(pp.name) = ANY (SELECT lower(a) FROM unnest(r.aliases) a));
  RETURN jsonb_build_object('ok', true, 'person', (SELECT x FROM jsonb_array_elements(bgc.my_people(email) -> 'people') x WHERE x ->> 'id' = r.legacy_id));
END $$;

-- Remove one of your people: deleted when they have no plays, hidden when they do (see the header)
CREATE OR REPLACE FUNCTION bgc.person_remove(email text, pkey text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); r players;
BEGIN
  SELECT * INTO r FROM players WHERE owner_id = mid AND legacy_id = pkey;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That person isn''t in your list'); END IF;
  IF r.linked_member_id = mid THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That''s you'); END IF;
  IF EXISTS (SELECT 1 FROM play_players WHERE player_id = r.id) THEN
    UPDATE players SET hidden = true, active = false, updated_at = now() WHERE id = r.id;
    RETURN jsonb_build_object('ok', true, 'removed', pkey, 'hidden', true);
  END IF;
  DELETE FROM players WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'removed', pkey);
END $$;

-- The keys of the people you hid, for the page's people list (GET /vault/people)
CREATE OR REPLACE FUNCTION bgc.hidden_people(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(legacy_id), '[]') FROM players WHERE owner_id = bgc.member_id(email) AND hidden $$;

COMMIT;
