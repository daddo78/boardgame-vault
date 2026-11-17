-- No more linking a player card to a new member by name (review, Nov 16). bgc.sign_in used to link an unlinked card on
-- Dan's shelf to any invited member whose Google display name matched it, so an invited stranger with the same name as
-- one of Dan's friends would take over that card's plays. A card is now linked only on purpose: an admin puts the
-- person's Google email on the card (Settings → Players), as at.apply_player already does. Links made so far stay.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 056_link_cards_by_email.sql  (or bash apply.sh)
BEGIN;

-- 017's sign_in, without the name match
-- Every signed-in request: are they a member (on the invite list)? Their card on Dan's shelf if an admin linked it
-- (by putting their email on it), whether they're an admin, and a visit for today.
CREATE OR REPLACE FUNCTION bgc.sign_in(email text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE m members; pkey text; pname text;
BEGIN
  SELECT * INTO m FROM members WHERE google_email = lower(email);
  IF NOT FOUND THEN RETURN jsonb_build_object('member', false); END IF;
  SELECT legacy_id, name INTO pkey, pname FROM players WHERE owner_id = at.admin_id() AND linked_member_id = m.id LIMIT 1;
  INSERT INTO member_days (member_id, day) VALUES (m.id, bgc.ask_day()) ON CONFLICT (member_id, day) DO UPDATE SET hits = member_days.hits + 1;
  UPDATE members SET last_seen_at = now() WHERE id = m.id;
  RETURN jsonb_build_object('member', true, 'id', m.id, 'name', m.display_name, 'isAdmin', m.is_admin, 'playerId', pkey, 'playerName', coalesce(pname, m.display_name));
END $$;

COMMIT;
