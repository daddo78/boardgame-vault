-- Plays logged on the site, and changes sent to BGG (Dan, Oct 25). "Log play" only worked on a phone with BG Stats; now
-- the site keeps the play itself, on any device. A member who links their BGG account (signs in once; we keep BGG's
-- session token, sealed with BGG_LINK_KEY, never the password) also gets their plays, collection and ratings sent to
-- BGG, the way BG Stats does it: a play logged here, a game added to or removed from the shelf, a wish, a rating.
--   plays.source        'bgg' (synced from BGG, as before) or 'site' (logged here; bgg_play_id fills in once BGG has it)
--   bgg_links           one per member: BGG username, sealed token, ok / expired
--   bgg_outbox          what is waiting to go to BGG. One pending 'item' row per member and game holds the wanted end
--                       state ({ own, wishlist, rating10 }), so five taps on the stars send one rating; a 'play' row per play.
-- Triggers on shelves, wishlist and ratings fill the outbox, so every path (adds by name, photo, spreadsheet; the n8n
-- fallback) is covered. Changes that came from BGG itself (the nightly stars) set bgc.from_bgg and aren't sent back.
-- Stars are in halves and a linked member's stars are their BGG rating: stars x 2 = BGG's 1-10.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 049_bgg_account.sql  (or bash apply.sh)
BEGIN;

ALTER TABLE plays ALTER COLUMN bgg_play_id DROP NOT NULL;
ALTER TABLE plays ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'bgg';
ALTER TABLE plays DROP CONSTRAINT IF EXISTS plays_source_check;
ALTER TABLE plays ADD CONSTRAINT plays_source_check CHECK (source IN ('bgg', 'site'));
ALTER TABLE plays ADD COLUMN IF NOT EXISTS logged_at timestamptz;
CREATE INDEX IF NOT EXISTS plays_site_idx ON plays (owner_id, bgg_id, played_on) WHERE bgg_play_id IS NULL;

-- What BG Stats puts in a play beside who won: each player's color, starting position and rating of the game. Kept, so a
-- play changed here goes back to BGG with them (BGG's play form replaces the whole play)
ALTER TABLE play_players ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '';
ALTER TABLE play_players ADD COLUMN IF NOT EXISTS start_position text NOT NULL DEFAULT '';
ALTER TABLE play_players ADD COLUMN IF NOT EXISTS rating text NOT NULL DEFAULT '';
-- 002's save, now with those three
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
    INSERT INTO plays (owner_id, bgg_play_id, played_on, game_id, bgg_id, game_name, quantity, minutes, location, comments, incomplete)
    VALUES (oid, (p ->> 'id')::bigint, nullif(nullif(p ->> 'date', ''), '0000-00-00')::date, (SELECT id FROM games WHERE bgg_id = (p ->> 'bggId')::int),
      (p ->> 'bggId')::int, coalesce(p ->> 'gameName', ''), coalesce((p ->> 'quantity')::int, 1), nullif((p ->> 'minutes')::int, 0),
      coalesce(p ->> 'location', ''), coalesce(p ->> 'comments', ''), coalesce((p ->> 'incomplete')::boolean, false))
    ON CONFLICT (owner_id, bgg_play_id) DO UPDATE SET played_on = EXCLUDED.played_on, game_id = EXCLUDED.game_id, bgg_id = EXCLUDED.bgg_id,
      game_name = EXCLUDED.game_name, quantity = EXCLUDED.quantity, minutes = EXCLUDED.minutes, location = EXCLUDED.location,
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

CREATE TABLE IF NOT EXISTS bgg_links (
  member_id     bigint PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  bgg_username  citext NOT NULL,
  token_sealed  text NOT NULL,              -- AES-256-GCM with BGG_LINK_KEY (bggAccount.ts); useless without the key
  expires_at    timestamptz,                -- when BGG said the token runs out
  state         text NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'expired')),
  last_error    text NOT NULL DEFAULT '',
  linked_at     timestamptz NOT NULL DEFAULT now(),
  last_sent_at  timestamptz,
  -- What goes to BGG, each on its own switch as in BG Stats (play posting, collection sync)
  send_plays       boolean NOT NULL DEFAULT true,
  send_collection  boolean NOT NULL DEFAULT true,  -- own and wishlist
  send_ratings     boolean NOT NULL DEFAULT true   -- stars out, and BGG's ratings back as stars
);
ALTER TABLE bgg_links ADD COLUMN IF NOT EXISTS send_plays boolean NOT NULL DEFAULT true;
ALTER TABLE bgg_links ADD COLUMN IF NOT EXISTS send_collection boolean NOT NULL DEFAULT true;
ALTER TABLE bgg_links ADD COLUMN IF NOT EXISTS send_ratings boolean NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS bgg_outbox (
  id           bigserial PRIMARY KEY,
  member_id    bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  bgg_id       integer NOT NULL,
  play_id      bigint REFERENCES plays(id) ON DELETE CASCADE,
  want         jsonb NOT NULL DEFAULT '{}',  -- item: { own?, wishlist?, rating10? (null clears) }
  state        text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'failed', 'skipped')),
  tries        int NOT NULL DEFAULT 0,
  next_try_at  timestamptz NOT NULL DEFAULT now(),
  error        text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz
);
-- What we last sent to BGG per member and game. BGG's collection XML lags its writes (a read straight after a change can
-- be an older cached copy), so for the fields we send, the worker trusts this over the XML for a few hours.
CREATE TABLE IF NOT EXISTS bgg_items (
  member_id  bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  bgg_id     integer NOT NULL,
  coll_id    integer,
  own        boolean,
  prevowned  boolean,
  wishlist   boolean,
  rating10   numeric(3,1),
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, bgg_id)
);

-- item: collection and rating; play: a play to send; unplay: a play to delete on BGG (want: { bggPlayId })
ALTER TABLE bgg_outbox DROP CONSTRAINT IF EXISTS bgg_outbox_kind_check;
ALTER TABLE bgg_outbox ADD CONSTRAINT bgg_outbox_kind_check CHECK (kind IN ('item', 'play', 'unplay'));

CREATE UNIQUE INDEX IF NOT EXISTS bgg_outbox_item_idx ON bgg_outbox (member_id, bgg_id) WHERE kind = 'item' AND state = 'pending';
CREATE INDEX IF NOT EXISTS bgg_outbox_pending_idx ON bgg_outbox (next_try_at) WHERE state = 'pending';

-- Something for a member's BGG collection: merged into their pending row for that game. Only for members who linked
-- BGG with that switch on (collection: own, wishlist; ratings: rating10), only for real BGG games, never for a change
-- that came from BGG, and not while the member is being deleted (a cascade has already removed the member row).
CREATE OR REPLACE FUNCTION bgc.bgg_want(mid bigint, bgg integer, patch jsonb) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF bgg IS NULL OR bgg <= 0 OR coalesce(current_setting('bgc.from_bgg', true), '') = 'on'
     OR NOT EXISTS (SELECT 1 FROM bgg_links l JOIN members m ON m.id = l.member_id WHERE l.member_id = mid
       AND CASE WHEN patch ? 'rating10' THEN l.send_ratings ELSE l.send_collection END) THEN RETURN; END IF;
  INSERT INTO bgg_outbox (member_id, kind, bgg_id, want) VALUES (mid, 'item', bgg, patch)
  ON CONFLICT (member_id, bgg_id) WHERE kind = 'item' AND state = 'pending'
  DO UPDATE SET want = bgg_outbox.want || EXCLUDED.want, next_try_at = least(bgg_outbox.next_try_at, now());
END $$;

CREATE OR REPLACE FUNCTION bgc.bgg_want_shelf() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM bgc.bgg_want(NEW.member_id, (SELECT bgg_id FROM games WHERE id = NEW.game_id), '{"own": true}');
  ELSE PERFORM bgc.bgg_want(OLD.member_id, (SELECT bgg_id FROM games WHERE id = OLD.game_id), '{"own": false}'); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS shelves_to_bgg ON shelves;
CREATE TRIGGER shelves_to_bgg AFTER INSERT OR DELETE ON shelves FOR EACH ROW EXECUTE FUNCTION bgc.bgg_want_shelf();

CREATE OR REPLACE FUNCTION bgc.bgg_want_wish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN PERFORM bgc.bgg_want(NEW.member_id, (SELECT bgg_id FROM games WHERE id = NEW.game_id), '{"wishlist": true}');
  ELSE PERFORM bgc.bgg_want(OLD.member_id, (SELECT bgg_id FROM games WHERE id = OLD.game_id), '{"wishlist": false}'); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS wishlist_to_bgg ON wishlist;
CREATE TRIGGER wishlist_to_bgg AFTER INSERT OR DELETE ON wishlist FOR EACH ROW EXECUTE FUNCTION bgc.bgg_want_wish();

CREATE OR REPLACE FUNCTION bgc.bgg_want_rating() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM bgc.bgg_want(OLD.member_id, (SELECT bgg_id FROM games WHERE id = OLD.game_id), '{"rating10": null}');
  ELSIF TG_OP = 'INSERT' OR NEW.stars IS DISTINCT FROM OLD.stars THEN
    PERFORM bgc.bgg_want(NEW.member_id, (SELECT bgg_id FROM games WHERE id = NEW.game_id), jsonb_build_object('rating10', NEW.stars * 2)); END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS ratings_to_bgg ON ratings;
CREATE TRIGGER ratings_to_bgg AFTER INSERT OR UPDATE OR DELETE ON ratings FOR EACH ROW EXECUTE FUNCTION bgc.bgg_want_rating();

-- Every play of the member's that BGG doesn't have yet (logged here before linking, or while sending plays was off)
-- goes into the outbox, unless it's already waiting. The worker checks BGG for the same play first, so one also
-- logged in BG Stats is matched, not sent twice. Returns how many were queued.
CREATE OR REPLACE FUNCTION bgc.bgg_queue_unsent_plays(mid bigint) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bgg_links WHERE member_id = mid AND send_plays) THEN RETURN 0; END IF;
  INSERT INTO bgg_outbox (member_id, kind, bgg_id, play_id)
  SELECT mid, 'play', p.bgg_id, p.id FROM plays p
  WHERE p.owner_id = mid AND p.bgg_play_id IS NULL AND p.bgg_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM bgg_outbox o WHERE o.play_id = p.id AND o.state = 'pending')
  ORDER BY p.played_on, p.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- The member's BGG link, for My profile and the Log a Play dialog
CREATE OR REPLACE FUNCTION bgc.bgg_link_status(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('linked', l.member_id IS NOT NULL, 'username', coalesce(l.bgg_username::text, m.bgg_username),
    'state', l.state, 'lastSent', at.iso(l.last_sent_at), 'expires', at.iso(l.expires_at),
    'plays', coalesce(l.send_plays, true), 'collection', coalesce(l.send_collection, true), 'ratings', coalesce(l.send_ratings, true),
    'waiting', (SELECT count(*) FROM bgg_outbox o WHERE o.member_id = m.id AND o.state = 'pending'),
    'failed', (SELECT count(*) FROM bgg_outbox o WHERE o.member_id = m.id AND o.state = 'failed' AND o.done_at > now() - interval '7 days'))
  FROM members m LEFT JOIN bgg_links l ON l.member_id = m.id WHERE m.google_email = email $$;

-- After a good sign-in on BGG (the API did it). Linking also makes it the username their plays sync from.
CREATE OR REPLACE FUNCTION bgc.bgg_link_save(email text, username text, sealed text, expires timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email);
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  -- A different BGG account: what we sent to the old one says nothing about the new one
  DELETE FROM bgg_items WHERE member_id = mid AND NOT EXISTS (SELECT 1 FROM bgg_links WHERE member_id = mid AND bgg_username = username::citext);
  INSERT INTO bgg_links (member_id, bgg_username, token_sealed, expires_at) VALUES (mid, username, sealed, expires)
  ON CONFLICT (member_id) DO UPDATE SET bgg_username = EXCLUDED.bgg_username, token_sealed = EXCLUDED.token_sealed,
    expires_at = EXCLUDED.expires_at, state = 'ok', last_error = '', linked_at = now();
  UPDATE members SET bgg_username = username, updated_at = now() WHERE id = mid AND bgg_username IS DISTINCT FROM username;
  UPDATE bgg_outbox SET next_try_at = now() WHERE member_id = mid AND state = 'pending'; -- what waited for a new sign-in goes now
  PERFORM bgc.bgg_queue_unsent_plays(mid); -- linking sends the plays BGG doesn't have yet
  RETURN jsonb_build_object('ok', true, 'link', bgc.bgg_link_status(email));
END $$;

-- The switches. s: { plays?, collection?, ratings? }; a switch turned off drops what was waiting under it
CREATE OR REPLACE FUNCTION bgc.bgg_link_settings(email text, s jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email);
BEGIN
  UPDATE bgg_links SET send_plays = coalesce((s ->> 'plays')::boolean, send_plays), send_collection = coalesce((s ->> 'collection')::boolean, send_collection),
    send_ratings = coalesce((s ->> 'ratings')::boolean, send_ratings) WHERE member_id = mid;
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

-- Unlinking forgets the token; anything still waiting is dropped (it would have nowhere to go)
CREATE OR REPLACE FUNCTION bgc.bgg_link_remove(email text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email);
BEGIN
  IF mid IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 401, 'message', 'Sign in to do that'); END IF;
  UPDATE bgg_outbox SET state = 'skipped', error = 'unlinked', done_at = now() WHERE member_id = mid AND state = 'pending';
  DELETE FROM bgg_links WHERE member_id = mid;
  DELETE FROM bgg_items WHERE member_id = mid;
  RETURN jsonb_build_object('ok', true, 'link', bgc.bgg_link_status(email));
END $$;

-- Log a play: of a game on your own shelf (gkey: its shelf id), or of any BGG game (p.bggId, p.title, p.cover: one you
-- played at a friend's, or don't own). p: { date: 'yyyy-mm-dd', minutes?, location?, comments?, players: [{ name, win? }] } (checked by the API)
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
    coalesce((x.v ->> 'win')::boolean, false), '', false
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

-- One shelf row's play count and last play, from the plays table (as bgc.refresh_member does for the whole shelf)
CREATE OR REPLACE FUNCTION bgc.recount_shelf_game(mid bigint, gid bigint) RETURNS void LANGUAGE sql AS $$
  UPDATE shelves s SET play_count = coalesce(x.plays, 0), last_played = x.last, updated_at = now()
  FROM (SELECT sum(pl.quantity)::int AS plays, max(pl.played_on) AS last FROM plays pl, shelves s2, games g
        WHERE s2.member_id = mid AND s2.game_id = gid AND g.id = gid AND pl.owner_id = mid AND (pl.bgg_id = g.bgg_id OR pl.bgg_id = ANY (s2.extra_bgg_ids))) x
  WHERE s.member_id = mid AND s.game_id = gid $$;

-- Your plays, newest first, a page at a time (skip: how many the pages before held). Every play: from BGG, BG Stats
-- or logged here; whether it's on BGG yet; the shelf id when the game is on your shelf.
DROP FUNCTION IF EXISTS bgc.my_plays(text, date, int);
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
      'onBgg', p.bgg_play_id IS NOT NULL,
      'sending', EXISTS (SELECT 1 FROM bgg_outbox o WHERE o.play_id = p.id AND o.state = 'pending'),
      'shelfId', (SELECT s.legacy_id FROM shelves s, me WHERE s.member_id = me.mid AND (s.game_id = p.game_id OR p.bgg_id = ANY (s.extra_bgg_ids)) LIMIT 1),
      'players', coalesce((SELECT jsonb_agg(jsonb_build_object('name', coalesce(q.name, pp.name), 'win', pp.win) ORDER BY pp.seat)
        FROM play_players pp LEFT JOIN players q ON q.id = pp.player_id WHERE pp.play_id = p.id), '[]'))
      ORDER BY p.played_on DESC NULLS LAST, p.id DESC) FROM page p LEFT JOIN games g ON g.id = p.game_id), '[]')) $$;

-- Where you've played lately, most recent first: the Where suggestions when logging a play
CREATE OR REPLACE FUNCTION bgc.play_places(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(place ORDER BY last DESC), '[]') FROM (
    SELECT btrim(location) AS place, max(coalesce(played_on, logged_at::date)) AS last FROM plays
    WHERE owner_id = bgc.member_id(email) AND btrim(location) <> '' GROUP BY btrim(location) ORDER BY last DESC LIMIT 20) x $$;

-- Delete one of your plays. On BGG too, when it's there and you linked BGG; a play that only came from BGG (no link)
-- would come back with the next sync, so that one is deleted on BGG instead.
CREATE OR REPLACE FUNCTION bgc.play_delete(email text, pid bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); p plays; linked boolean; gid bigint;
BEGIN
  SELECT * INTO p FROM plays WHERE id = pid AND owner_id = mid;
  IF p.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 404, 'message', 'That play isn''t yours, or is already gone'); END IF;
  linked := EXISTS (SELECT 1 FROM bgg_links WHERE member_id = mid AND send_plays);
  IF p.bgg_play_id IS NOT NULL AND NOT linked THEN
    RETURN jsonb_build_object('ok', false, 'status', 409, 'message', 'That play is on BGG, so it would come back with the next sync. Delete it on BGG (or BG Stats), or link BGG in My profile and delete it here.');
  END IF;
  IF p.bgg_play_id IS NOT NULL THEN
    INSERT INTO bgg_outbox (member_id, kind, bgg_id, want) VALUES (mid, 'unplay', p.bgg_id, jsonb_build_object('bggPlayId', p.bgg_play_id));
  END IF;
  DELETE FROM plays WHERE id = pid;
  FOR gid IN SELECT s.game_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = mid AND (g.bgg_id = p.bgg_id OR p.bgg_id = ANY (s.extra_bgg_ids)) LOOP
    PERFORM bgc.recount_shelf_game(mid, gid);
  END LOOP;
  RETURN jsonb_build_object('ok', true, 'deleted', pid, 'fromBgg', p.bgg_play_id IS NOT NULL);
END $$;

-- The worker's next writes: pending rows whose member's link is good, oldest first, with what each needs
CREATE OR REPLACE FUNCTION bgc.bgg_out_next(lim int) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'id')::bigint), '[]') FROM (
    SELECT jsonb_build_object('id', o.id, 'memberId', o.member_id, 'kind', o.kind, 'bggId', o.bgg_id, 'want', o.want, 'tries', o.tries,
      'username', l.bgg_username::text, 'sealed', l.token_sealed,
      'known', (SELECT jsonb_build_object('collId', i.coll_id, 'own', i.own, 'prevowned', i.prevowned, 'wishlist', i.wishlist, 'rating10', i.rating10, 'sentAt', at.iso(i.sent_at))
        FROM bgg_items i WHERE i.member_id = o.member_id AND i.bgg_id = o.bgg_id AND o.kind = 'item' AND i.sent_at > now() - interval '6 hours'),
      'play', CASE WHEN o.kind = 'play' THEN (SELECT jsonb_build_object('id', p.id, 'bggPlayId', p.bgg_play_id, 'date', p.played_on, 'minutes', p.minutes,
        'quantity', p.quantity, 'location', p.location, 'comments', p.comments,
        'players', coalesce((SELECT jsonb_agg(jsonb_build_object('name', pp.name, 'username', pp.bgg_user, 'win', pp.win, 'score', pp.score, 'isNew', pp.is_new,
          'color', pp.color, 'position', pp.start_position, 'rating', pp.rating) ORDER BY pp.seat)
          FROM play_players pp WHERE pp.play_id = p.id), '[]')) FROM plays p WHERE p.id = o.play_id) END) AS x
    FROM bgg_outbox o JOIN bgg_links l ON l.member_id = o.member_id AND l.state = 'ok'
    WHERE o.state = 'pending' AND o.next_try_at <= now()
    ORDER BY o.id LIMIT lim) q $$;

-- What BGG said. r: { outcome: ok | auth | gone | error, message?, bggPlayId?, sent?: { collId, own, prevowned, wishlist, rating10 } }
--   ok: done (a play gets its BGG id, so the nightly sync updates this row instead of adding another)
--   auth: the member signs in to BGG again; the row waits for that
--   gone: what we were changing isn't on BGG; error: tried again later (1, 5, 30 minutes, 2 h, 12 h), failed after 6 tries
DROP FUNCTION IF EXISTS bgc.bgg_out_result(bigint, jsonb);
CREATE OR REPLACE FUNCTION bgc.bgg_out_result(oid bigint, r jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE o bgg_outbox; out text := r ->> 'outcome'; msg text := left(coalesce(r ->> 'message', ''), 300);
BEGIN
  SELECT * INTO o FROM bgg_outbox WHERE id = oid;
  IF o.id IS NULL THEN RETURN false; END IF;
  IF out = 'ok' THEN
    UPDATE bgg_outbox SET state = 'done', done_at = now(), error = '', tries = tries + 1 WHERE id = oid;
    UPDATE bgg_links SET last_sent_at = now(), last_error = '' WHERE member_id = o.member_id;
    IF o.kind = 'item' AND jsonb_typeof(r -> 'sent') = 'object' THEN
      INSERT INTO bgg_items (member_id, bgg_id, coll_id, own, prevowned, wishlist, rating10)
      VALUES (o.member_id, o.bgg_id, nullif(r -> 'sent' ->> 'collId', '')::int, (r -> 'sent' ->> 'own')::boolean, (r -> 'sent' ->> 'prevowned')::boolean,
        (r -> 'sent' ->> 'wishlist')::boolean, (r -> 'sent' ->> 'rating10')::numeric)
      ON CONFLICT (member_id, bgg_id) DO UPDATE SET coll_id = coalesce(EXCLUDED.coll_id, bgg_items.coll_id), own = EXCLUDED.own,
        prevowned = EXCLUDED.prevowned, wishlist = EXCLUDED.wishlist, rating10 = EXCLUDED.rating10, sent_at = now();
    END IF;
    IF o.kind = 'play' AND (r ->> 'bggPlayId') IS NOT NULL THEN
      -- The nightly sync may already have brought this play in (posted, then the answer lost): keep that one
      IF EXISTS (SELECT 1 FROM plays WHERE owner_id = o.member_id AND bgg_play_id = (r ->> 'bggPlayId')::bigint AND id <> o.play_id) THEN
        DELETE FROM plays WHERE id = o.play_id;
      ELSE
        UPDATE plays SET bgg_play_id = (r ->> 'bggPlayId')::bigint WHERE id = o.play_id;
      END IF;
    END IF;
  ELSIF out = 'auth' THEN
    UPDATE bgg_links SET state = 'expired', last_error = msg WHERE member_id = o.member_id;
    UPDATE bgg_outbox SET error = msg WHERE id = oid;
  ELSIF out = 'gone' THEN
    UPDATE bgg_outbox SET state = 'skipped', done_at = now(), error = msg, tries = tries + 1 WHERE id = oid;
  ELSE
    UPDATE bgg_outbox SET tries = tries + 1, error = msg,
      state = CASE WHEN tries + 1 >= 6 THEN 'failed' ELSE 'pending' END, done_at = CASE WHEN tries + 1 >= 6 THEN now() END,
      next_try_at = now() + (ARRAY[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '12 hours', interval '12 hours'])[least(tries + 1, 6)]
    WHERE id = oid;
    UPDATE bgg_links SET last_error = msg WHERE member_id = o.member_id;
  END IF;
  RETURN true;
END $$;

-- After a member's BGG plays sync: a play logged here that BGG now has (they also logged it in BG Stats, or before they
-- linked BGG) is the same play: same game, same day, same people. The BGG one stays; ours, and anything waiting to
-- send it, goes. One for one: two plays logged here and one on BGG leaves one of ours. Returns how many were merged.
CREATE OR REPLACE FUNCTION bgc.merge_site_plays(email text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE mid bigint := bgc.member_id(email); n int;
BEGIN
  WITH who AS (
    SELECT p.id, p.bgg_id, p.played_on, p.source, p.bgg_play_id,
      coalesce((SELECT string_agg(lower(btrim(pp.name)), ',' ORDER BY lower(btrim(pp.name))) FROM play_players pp WHERE pp.play_id = p.id), '') AS names
    FROM plays p WHERE p.owner_id = mid AND p.played_on IS NOT NULL
      AND (p.bgg_play_id IS NULL OR p.source = 'bgg')),
  ours AS (SELECT id, bgg_id, played_on, names, row_number() OVER (PARTITION BY bgg_id, played_on, names ORDER BY id) AS k FROM who WHERE bgg_play_id IS NULL),
  theirs AS (SELECT bgg_id, played_on, names, count(*) AS c FROM who WHERE source = 'bgg' GROUP BY 1, 2, 3)
  DELETE FROM plays p USING ours o JOIN theirs t USING (bgg_id, played_on, names)
  WHERE p.id = o.id AND o.k <= t.c;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM bgc.refresh_member(email); END IF;
  RETURN n;
END $$;

-- The nightly BGG ratings, for members who linked BGG: their BGG rating is their stars (BGG's 1-10 / 2, to the half).
-- A rating changed here and not yet sent to BGG, or sent in the last 6 hours, wins. Marked as from BGG, so it isn't sent back.
CREATE OR REPLACE FUNCTION bgc.stars_from_bgg(username text) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int := 0;
BEGIN
  PERFORM set_config('bgc.from_bgg', 'on', true);
  INSERT INTO ratings (member_id, game_id, stars)
  SELECT l.member_id, g.id, greatest(0.5, least(5, round(b.rating) / 2))
  FROM bgg_links l JOIN bgg_ratings b ON b.bgg_username = l.bgg_username JOIN games g ON g.bgg_id = b.bgg_id
  WHERE l.bgg_username = username::citext AND l.send_ratings
    AND NOT EXISTS (SELECT 1 FROM bgg_outbox o WHERE o.member_id = l.member_id AND o.bgg_id = b.bgg_id AND o.kind = 'item'
      AND o.state = 'pending' AND o.want ? 'rating10')
    -- just sent from here: BGG's XML may still be the older copy
    AND NOT EXISTS (SELECT 1 FROM bgg_items i WHERE i.member_id = l.member_id AND i.bgg_id = b.bgg_id AND i.sent_at > now() - interval '6 hours')
  ON CONFLICT (member_id, game_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now() WHERE ratings.stars IS DISTINCT FROM EXCLUDED.stars;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('bgc.from_bgg', 'off', true);
  RETURN n;
END $$;

COMMIT;
