-- Your people, your places, and editing a play (Dan, Oct 26). The Players screen was the admin's alone (Dan's shelf,
-- through the Airtable adapter); now every member keeps the people on their own shelf: the people they play with,
-- members or not, whom Log a Play's search offers. Places are the same for Where: a short saved list, plus every place
-- already in your plays. And a play can be opened and changed; one on BGG is changed there too (bggOutbox).
--   bgc.my_people / person_save / person_remove     your shelf's people (an admin also links a Google email, as before)
--   places, bgc.my_places / place_save               saved places; bgc.play_places (049) now offers them first
--   bgc.play_get / play_edit                         one play, and changing it (an outbox 'play' row with want.edit)
--   bgc.person_merge / place_merge                   two names for one person or place become one; the old name is
--                                                    kept (another name / places.aliases), so the nightly sync files
--                                                    plays under it in the right place. Merges change plays here only:
--                                                    rewriting hundreds of BGG plays from our copy isn't worth the risk.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 050_people_places.sql  (or bash apply.sh)
BEGIN;

-- ---------- People ----------
-- Your people, most played first: name, other names (as BG Stats logged them), active, BGG username, whether they're
-- a member here, plays and games together. A member's email shows only to an admin on their own shelf (041's rule).
CREATE OR REPLACE FUNCTION bgc.my_people(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS mid, bgc.is_admin(email) AND bgc.member_id(email) = at.admin_id() AS emails)
  SELECT jsonb_build_object('ok', true, 'people', coalesce(jsonb_agg(x ORDER BY (x ->> 'active')::boolean DESC, (x ->> 'plays')::int DESC, x ->> 'name'), '[]'))
  FROM (
    SELECT jsonb_strip_nulls(jsonb_build_object('id', p.legacy_id, 'name', p.name, 'aliases', to_jsonb(p.aliases), 'active', p.active,
      'bggUsername', coalesce(nullif(p.bgg_username, ''), m.bgg_username), 'member', m.id IS NOT NULL, 'me', p.linked_member_id = me.mid,
      'googleEmail', CASE WHEN me.emails THEN m.google_email::text END,
      'plays', coalesce(c.plays, 0), 'games', coalesce(c.games, 0), 'last', c.last)) AS x
    FROM me JOIN players p ON p.owner_id = me.mid
    LEFT JOIN members m ON m.id = p.linked_member_id
    LEFT JOIN LATERAL (SELECT sum(pl.quantity)::int AS plays, count(DISTINCT pl.bgg_id)::int AS games, max(pl.played_on) AS last
      FROM play_players pp JOIN plays pl ON pl.id = pp.play_id WHERE pp.player_id = p.id) c ON true) q $$;

-- Add (pkey null) or change one of your people. p: { name, aliases: [..], active, bggUsername, googleEmail? (admins, own shelf) }
CREATE OR REPLACE FUNCTION bgc.person_save(email text, pkey text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); r players; nm text := btrim(coalesce(p ->> 'name', ''));
  al text[] := ARRAY(SELECT DISTINCT btrim(a) FROM jsonb_array_elements_text(coalesce(p -> 'aliases', '[]')) a WHERE btrim(a) <> '' AND lower(btrim(a)) <> lower(btrim(coalesce(p ->> 'name', ''))));
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF nm = '' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Give them a name'); END IF;
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

-- Two names for one person: "from" goes into "into". Their plays move over, "from"'s names become other names of
-- "into" (so a sync bringing in "from" files it under "into"), and "from" is removed. You can take someone in, but
-- can't be merged into someone else; two different members can't be one person.
CREATE OR REPLACE FUNCTION bgc.person_merge(email text, from_key text, into_key text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); a players; b players;
BEGIN
  SELECT * INTO a FROM players WHERE owner_id = mid AND legacy_id = from_key;
  SELECT * INTO b FROM players WHERE owner_id = mid AND legacy_id = into_key;
  IF a.id IS NULL OR b.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'Pick two of your people'); END IF;
  IF a.id = b.id THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That''s the same person'); END IF;
  IF a.linked_member_id = mid THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'You can''t be merged into someone else (merge them into you instead)'); END IF;
  IF a.linked_member_id IS NOT NULL AND b.linked_member_id IS NOT NULL AND a.linked_member_id <> b.linked_member_id THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'message', a.name || ' and ' || b.name || ' are two different members here');
  END IF;
  DELETE FROM players WHERE id = a.id; -- first, so the names it frees can't clash
  UPDATE players SET
    aliases = ARRAY(SELECT DISTINCT n FROM unnest(b.aliases || a.name || a.aliases) n WHERE lower(n) <> lower(b.name)),
    bgg_username = coalesce(nullif(b.bgg_username, ''), nullif(a.bgg_username, '')),
    linked_member_id = coalesce(b.linked_member_id, a.linked_member_id), active = b.active OR a.active, updated_at = now()
  WHERE id = b.id;
  -- Their seats (the delete set them to no one) and any seat by one of the names
  UPDATE play_players pp SET player_id = b.id, name = b.name FROM plays pl
  WHERE pp.play_id = pl.id AND pl.owner_id = mid AND (pp.player_id IS NULL OR pp.player_id = b.id)
    AND (lower(pp.name) = lower(a.name) OR lower(pp.name) = ANY (SELECT lower(n) FROM unnest(a.aliases) n) OR pp.player_id = b.id);
  RETURN jsonb_build_object('ok', true, 'into', into_key) || bgc.my_people(email);
END $$;

-- Remove one of your people. Only someone with no plays: anyone in your plays comes back with the next sync (rename
-- them instead, or add the other spelling as another name).
CREATE OR REPLACE FUNCTION bgc.person_remove(email text, pkey text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); r players;
BEGIN
  SELECT * INTO r FROM players WHERE owner_id = mid AND legacy_id = pkey;
  IF r.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That person isn''t in your list'); END IF;
  IF r.linked_member_id = mid THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'That''s you'); END IF;
  IF EXISTS (SELECT 1 FROM play_players WHERE player_id = r.id) THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'message', r.name || ' is in your plays, so they''d come back with the next sync. Rename them, or add the name as another name of someone else.');
  END IF;
  DELETE FROM players WHERE id = r.id;
  RETURN jsonb_build_object('ok', true, 'removed', pkey);
END $$;

-- ---------- Places ----------
CREATE TABLE IF NOT EXISTS places (
  member_id   bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS places_name_idx ON places (member_id, lower(name));
ALTER TABLE places ADD COLUMN IF NOT EXISTS aliases text[] NOT NULL DEFAULT '{}'; -- names merged into this one

-- Your places: the saved ones and every place in your plays, each with its plays and last play
CREATE OR REPLACE FUNCTION bgc.my_places(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS mid),
  used AS (SELECT lower(btrim(location)) AS k, min(btrim(location)) AS name, sum(quantity)::int AS plays, max(played_on) AS last
           FROM plays, me WHERE owner_id = me.mid AND btrim(location) <> '' GROUP BY 1),
  saved AS (SELECT lower(name) AS k, name FROM places, me WHERE member_id = me.mid)
  SELECT jsonb_build_object('ok', true, 'places', coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name', coalesce(s.name, u.name), 'saved', s.k IS NOT NULL,
    'plays', coalesce(u.plays, 0), 'last', u.last)) ORDER BY s.k IS NULL, u.last DESC NULLS LAST, coalesce(s.name, u.name)), '[]'))
  FROM saved s FULL JOIN used u ON u.k = s.k $$;

-- p: { action: add | remove, name }. Removing a place only takes it off the list; plays keep where they were.
CREATE OR REPLACE FUNCTION bgc.place_save(email text, p jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); nm text := left(btrim(coalesce(p ->> 'name', '')), 100);
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF nm = '' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Name the place'); END IF;
  IF p ->> 'action' = 'remove' THEN DELETE FROM places WHERE member_id = mid AND lower(name) = lower(nm);
  ELSE INSERT INTO places (member_id, name) VALUES (mid, nm) ON CONFLICT (member_id, lower(name)) DO NOTHING;
  END IF;
  RETURN bgc.my_places(email);
END $$;

-- Two names for one place: plays at "from" move to "into", which is saved with "from" as an old name (so plays synced
-- from BGG under it are moved too, by bgc.apply_place_aliases after each sync), and "from" leaves the list.
CREATE OR REPLACE FUNCTION bgc.place_merge(email text, from_name text, into_name text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); f text := btrim(coalesce(from_name, '')); t text := left(btrim(coalesce(into_name, '')), 100); old text[]; n int;
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  IF f = '' OR t = '' OR lower(f) = lower(t) THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Pick two different places'); END IF;
  SELECT coalesce(aliases, '{}') INTO old FROM places WHERE member_id = mid AND lower(name) = lower(f);
  DELETE FROM places WHERE member_id = mid AND lower(name) = lower(f);
  INSERT INTO places (member_id, name, aliases) VALUES (mid, t, ARRAY(SELECT DISTINCT x FROM unnest(ARRAY[f] || coalesce(old, '{}')) x WHERE lower(x) <> lower(t)))
  ON CONFLICT (member_id, lower(name)) DO UPDATE SET aliases = ARRAY(SELECT DISTINCT x FROM unnest(places.aliases || EXCLUDED.aliases) x WHERE lower(x) <> lower(places.name));
  n := bgc.apply_place_aliases(email);
  RETURN jsonb_build_object('ok', true, 'moved', n) || bgc.my_places(email);
END $$;

-- Plays at a place's old names say its name now (after a merge, and after each sync brings plays from BGG)
CREATE OR REPLACE FUNCTION bgc.apply_place_aliases(email text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); n int;
BEGIN
  UPDATE plays p SET location = pl.name FROM places pl
  WHERE pl.member_id = mid AND p.owner_id = mid AND cardinality(pl.aliases) > 0
    AND lower(btrim(p.location)) = ANY (SELECT lower(x) FROM unnest(pl.aliases) x);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Where suggestions: saved places first, then the rest by when you last played there
CREATE OR REPLACE FUNCTION bgc.play_places(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(x ->> 'name'), '[]') FROM (SELECT x FROM jsonb_array_elements(bgc.my_places(email) -> 'places') x LIMIT 30) q $$;

-- ---------- One play ----------
-- Editable here when it's from the site, or on BGG with BGG linked (then the change goes there too). A play that only
-- came from BGG, without a link, would be put back by the next sync, so it's shown read-only.
CREATE OR REPLACE FUNCTION bgc.play_get(email text, pid bigint) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p.id IS NULL THEN jsonb_build_object('ok', false, 'status', 404, 'message', 'That play isn''t yours, or is gone') ELSE
    jsonb_build_object('ok', true, 'play', jsonb_build_object('id', p.id, 'date', p.played_on, 'bggId', p.bgg_id, 'title', coalesce(g.title, p.game_name),
      'cover', g.cover_card, 'minutes', p.minutes, 'location', p.location, 'comments', p.comments, 'source', p.source, 'onBgg', p.bgg_play_id IS NOT NULL,
      'editable', p.bgg_play_id IS NULL OR EXISTS (SELECT 1 FROM bgg_links WHERE member_id = p.owner_id AND send_plays),
      'shelfId', (SELECT s.legacy_id FROM shelves s WHERE s.member_id = p.owner_id AND (s.game_id = p.game_id OR p.bgg_id = ANY (s.extra_bgg_ids)) LIMIT 1),
      'players', coalesce((SELECT jsonb_agg(jsonb_build_object('name', coalesce(q.name, pp.name), 'win', pp.win) ORDER BY pp.seat)
        FROM play_players pp LEFT JOIN players q ON q.id = pp.player_id WHERE pp.play_id = p.id), '[]'))) END
  FROM (SELECT bgc.member_id(email) AS mid) me LEFT JOIN plays p ON p.id = pid AND p.owner_id = me.mid LEFT JOIN games g ON g.id = p.game_id $$;

-- Change a play: date, who (and who won), where, how long, notes. p as for bgc.log_play (checked by the API).
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
  -- What only BGG/BG Stats records about each seat (score, color, start, their rating) stays with the person
  CREATE TEMP TABLE IF NOT EXISTS old_seats ON COMMIT DROP AS SELECT * FROM play_players WITH NO DATA;
  DELETE FROM old_seats;
  INSERT INTO old_seats SELECT * FROM play_players WHERE play_id = pid;
  DELETE FROM play_players WHERE play_id = pid;
  INSERT INTO play_players (play_id, seat, player_id, name, bgg_user, win, score, is_new, color, start_position, rating)
  SELECT pid, x.n, q.id, btrim(x.v ->> 'name'),
    coalesce(nullif(q.bgg_username, ''), (SELECT m.bgg_username FROM members m WHERE m.id = q.linked_member_id), o.bgg_user, ''),
    coalesce((x.v ->> 'win')::boolean, false), coalesce(o.score, ''), coalesce(o.is_new, false), coalesce(o.color, ''), coalesce(o.start_position, ''), coalesce(o.rating, '')
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
