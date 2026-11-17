-- The BGG outbox claims what it sends, and notices changes made while a row was on its way (review, Nov 16).
-- Before: bgg_out_next only read the pending rows, so two runs at once (the worker, and the API running the job itself
-- when the worker said "already running") sent the same plays to BGG twice. And a change made while a batch was going
-- out (a new star merged into the row, a play edited) was marked done with the old values, so it never reached BGG.
-- Now:
--   * bgg_out_next claims the rows it hands out (claimed_until, 45 minutes; FOR UPDATE SKIP LOCKED), so a second run
--     takes other rows or none; a claim left by a run that died runs out by itself.
--   * rev goes up whenever what a pending row would send changes: its want (merged item changes), or its play and seats.
--     The claim remembers the rev it handed out (claimed_rev).
--   * bgg_out_result marks a row done only if rev is still what was sent; otherwise it stays pending, due now, and a play
--     that has reached BGG goes again as an edit.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 055_outbox_claims.sql  (or bash apply.sh)
BEGIN;

ALTER TABLE bgg_outbox ADD COLUMN IF NOT EXISTS rev int NOT NULL DEFAULT 0;
ALTER TABLE bgg_outbox ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
ALTER TABLE bgg_outbox ADD COLUMN IF NOT EXISTS claimed_rev int;
-- Deleting a play (merges, deletes) looked through the whole outbox for its rows
CREATE INDEX IF NOT EXISTS bgg_outbox_play ON bgg_outbox (play_id) WHERE play_id IS NOT NULL;

-- A pending row's own change: an item's want merged by a later star, heart or wishlist change
CREATE OR REPLACE FUNCTION bgc.outbox_rev_want() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.want IS DISTINCT FROM OLD.want THEN NEW.rev := OLD.rev + 1; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS outbox_rev_want ON bgg_outbox;
CREATE TRIGGER outbox_rev_want BEFORE UPDATE OF want ON bgg_outbox FOR EACH ROW EXECUTE FUNCTION bgc.outbox_rev_want();

-- A play changed while its row waits (or is on its way): what it would send has changed
CREATE OR REPLACE FUNCTION bgc.outbox_rev_play() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bgg_outbox SET rev = rev + 1 WHERE play_id = NEW.id AND state = 'pending';
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION bgc.outbox_rev_seat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN UPDATE bgg_outbox SET rev = rev + 1 WHERE play_id = OLD.play_id AND state = 'pending';
  ELSE UPDATE bgg_outbox SET rev = rev + 1 WHERE play_id = NEW.play_id AND state = 'pending'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS outbox_rev_play ON plays;
CREATE TRIGGER outbox_rev_play AFTER UPDATE ON plays FOR EACH ROW
  WHEN (ROW(OLD.played_on, OLD.minutes, OLD.quantity, OLD.location, OLD.comments, OLD.bgg_id)
        IS DISTINCT FROM ROW(NEW.played_on, NEW.minutes, NEW.quantity, NEW.location, NEW.comments, NEW.bgg_id))
  EXECUTE FUNCTION bgc.outbox_rev_play();
DROP TRIGGER IF EXISTS outbox_rev_seats ON play_players;
CREATE TRIGGER outbox_rev_seats AFTER INSERT OR UPDATE OR DELETE ON play_players FOR EACH ROW EXECUTE FUNCTION bgc.outbox_rev_seat();

-- 052's bgg_out_next, now claiming what it hands out (and only rows nobody else holds)
DROP FUNCTION IF EXISTS bgc.bgg_out_next(int);
CREATE FUNCTION bgc.bgg_out_next(lim int) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE ids bigint[];
BEGIN
  WITH picked AS (
    SELECT o.id FROM bgg_outbox o JOIN bgg_links l ON l.member_id = o.member_id AND l.state = 'ok'
    WHERE o.state = 'pending' AND o.next_try_at <= now() AND (o.claimed_until IS NULL OR o.claimed_until < now())
    ORDER BY o.id LIMIT lim FOR UPDATE OF o SKIP LOCKED)
  , claimed AS (
    UPDATE bgg_outbox b SET claimed_until = now() + interval '45 minutes', claimed_rev = b.rev FROM picked WHERE b.id = picked.id RETURNING b.id)
  SELECT coalesce(array_agg(id), '{}') INTO ids FROM claimed;
  RETURN (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'id')::bigint), '[]') FROM (
    SELECT jsonb_build_object('id', o.id, 'memberId', o.member_id, 'kind', o.kind, 'bggId', o.bgg_id, 'want', o.want, 'tries', o.tries,
      'username', l.bgg_username::text, 'sealed', l.token_sealed,
      'known', (SELECT jsonb_build_object('collId', i.coll_id, 'own', i.own, 'prevowned', i.prevowned, 'wishlist', i.wishlist, 'rating10', i.rating10, 'sentAt', at.iso(i.sent_at))
        FROM bgg_items i WHERE i.member_id = o.member_id AND i.bgg_id = o.bgg_id AND o.kind = 'item' AND i.sent_at > now() - interval '6 hours'),
      'play', CASE WHEN o.kind = 'play' THEN (SELECT jsonb_build_object('id', p.id, 'bggPlayId', p.bgg_play_id, 'date', p.played_on, 'minutes', p.minutes,
        'quantity', p.quantity, 'location', CASE WHEN l.send_location THEN p.location ELSE p.bgg_location END, 'comments', p.comments,
        'players', coalesce((SELECT jsonb_agg(jsonb_build_object('name', pp.name, 'username', pp.bgg_user, 'win', pp.win, 'score', pp.score, 'isNew', pp.is_new,
          'color', pp.color, 'position', pp.start_position, 'rating', pp.rating) ORDER BY pp.seat)
          FROM play_players pp WHERE pp.play_id = p.id), '[]')) FROM plays p WHERE p.id = o.play_id) END) AS x
    FROM bgg_outbox o JOIN bgg_links l ON l.member_id = o.member_id
    WHERE o.id = ANY (ids)) q);
END $$;

-- 049's bgg_out_result, now letting go of the claim, and keeping a row that changed on its way pending
CREATE OR REPLACE FUNCTION bgc.bgg_out_result(oid bigint, r jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE o bgg_outbox; out text := r ->> 'outcome'; msg text := left(coalesce(r ->> 'message', ''), 300); changed boolean;
BEGIN
  SELECT * INTO o FROM bgg_outbox WHERE id = oid FOR UPDATE;
  IF o.id IS NULL THEN RETURN false; END IF;
  changed := o.claimed_rev IS NOT NULL AND o.rev <> o.claimed_rev;
  IF out = 'ok' THEN
    IF changed THEN
      -- Sent, but it changed meanwhile: send again now (a play already on BGG goes as an edit)
      UPDATE bgg_outbox SET claimed_until = NULL, claimed_rev = NULL, error = '', next_try_at = now(),
        want = CASE WHEN kind = 'play' THEN want || '{"edit": true}'::jsonb ELSE want END WHERE id = oid;
    ELSE
      UPDATE bgg_outbox SET state = 'done', done_at = now(), error = '', tries = tries + 1, claimed_until = NULL WHERE id = oid;
    END IF;
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
    UPDATE bgg_outbox SET error = msg, claimed_until = NULL WHERE id = oid;
  ELSIF out = 'gone' THEN
    UPDATE bgg_outbox SET state = 'skipped', done_at = now(), error = msg, tries = tries + 1, claimed_until = NULL WHERE id = oid;
  ELSE
    UPDATE bgg_outbox SET tries = tries + 1, error = msg, claimed_until = NULL,
      state = CASE WHEN tries + 1 >= 6 THEN 'failed' ELSE 'pending' END, done_at = CASE WHEN tries + 1 >= 6 THEN now() END,
      next_try_at = now() + (ARRAY[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours', interval '12 hours', interval '12 hours'])[least(tries + 1, 6)]
    WHERE id = oid;
    UPDATE bgg_links SET last_error = msg WHERE member_id = o.member_id;
  END IF;
  RETURN true;
END $$;

COMMIT;
