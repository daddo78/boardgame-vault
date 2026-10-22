-- The site's rules as one self-check: bgc.self_check() runs every check, undoes all its changes, and returns the results.
-- Used after every deploy and by the nightly self-test. Generated from server/bgc-db/tests/checks.sql by make-021.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 021_self_check.sql  (safe to re-run)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.self_check() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE res jsonb := '[]';
BEGIN
  BEGIN
    INSERT INTO members (google_email, display_name) VALUES ('check.member@example.invalid', 'Check Member');
    res := res || jsonb_build_object('what', 'a member who isn''t in Dan''s plays can sign in', 'ok', coalesce(((bgc.sign_in('check.member@example.invalid') ->> 'member')::boolean), false));
    res := res || jsonb_build_object('what', 'a stranger can''t sign in', 'ok', coalesce((NOT (bgc.sign_in('stranger@example.invalid') ->> 'member')::boolean), false));
    res := res || jsonb_build_object('what', 'signing in doesn''t add someone to Dan''s people', 'ok', coalesce((NOT EXISTS (SELECT 1 FROM players p JOIN members m ON m.id = p.linked_member_id
  WHERE p.owner_id = at.admin_id() AND m.google_email = 'check.member@example.invalid')), false));
    res := res || jsonb_build_object('what', 'Dan signs in as an admin', 'ok', coalesce(((bgc.sign_in('dandehaan@gmail.com') ->> 'isAdmin')::boolean), false));
    res := res || jsonb_build_object('what', 'a member''s "main" is their own shelf', 'ok', coalesce((bgc.shelf_view('check.member@example.invalid', 'main', NULL) ->> 'shelf' = 'mine'), false));
    res := res || jsonb_build_object('what', 'a non-friend can''t view Dan''s shelf through Nathan', 'ok', coalesce((bgc.shelf_view('check.member@example.invalid', 'friend:1', NULL) ->> 'shelf' = 'mine'), false));
    res := res || jsonb_build_object('what', 'a non-friend can''t open Dan''s shelf', 'ok', coalesce((NOT (bgc.friend_shelf('check.member@example.invalid', 1) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a non-friend can''t see Dan''s profile page', 'ok', coalesce((NOT (bgc.profile_page('check.member@example.invalid', 1) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a non-friend can''t see Dan''s wishlist', 'ok', coalesce((NOT (bgc.wishlist('check.member@example.invalid', 1) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'Dan''s home is the main collection', 'ok', coalesce((bgc.shelf_view('dandehaan@gmail.com', 'main', NULL) ->> 'shelf' = 'main'), false));
    res := res || jsonb_build_object('what', 'a friend can open Dan''s shelf', 'ok', coalesce(((bgc.friend_shelf('nathan.schmidt@curator.invalid', 1) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a friend never sees Dan''s give-away list', 'ok', coalesce((NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.friend_shelf('nathan.schmidt@curator.invalid', 1) -> 'records') r
  WHERE (r -> 'fields' ->> 'fldskzh1rq9uchgYI')::boolean)), false));
    res := res || jsonb_build_object('what', 'entering a friend code connects', 'ok', coalesce(((bgc.add_friend('check.member@example.invalid', (SELECT friend_code FROM members WHERE id = 1)) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'after connecting, the new friend can open Dan''s shelf', 'ok', coalesce(((bgc.friend_shelf('check.member@example.invalid', 1) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', '"at Check''s" finds the friend by first name', 'ok', coalesce((bgc.friend_by_name('dandehaan@gmail.com', 'Check') = bgc.member_id('check.member@example.invalid')), false));
    res := res || jsonb_build_object('what', 'a friend can rate a game on Dan''s shelf', 'ok', coalesce(((bgc.rate('check.member@example.invalid', (SELECT legacy_id FROM shelves WHERE member_id = 1 ORDER BY num LIMIT 1), 4) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'the rating is saved on their own account', 'ok', coalesce(((SELECT stars FROM ratings WHERE member_id = bgc.member_id('check.member@example.invalid')) = 4), false));
    res := res || jsonb_build_object('what', 'clearing a rating is accepted', 'ok', coalesce(((bgc.rate('check.member@example.invalid', (SELECT legacy_id FROM shelves WHERE member_id = 1 ORDER BY num LIMIT 1), 0) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'rating 0 clears it', 'ok', coalesce((NOT EXISTS (SELECT 1 FROM ratings WHERE member_id = bgc.member_id('check.member@example.invalid'))), false));
    res := res || jsonb_build_object('what', 'adding to a wishlist', 'ok', coalesce((jsonb_array_length(bgc.wish_change('check.member@example.invalid', 'add', 224517, 'Brass: Birmingham', NULL) -> 'items') = 1), false));
    res := res || jsonb_build_object('what', 'buy ideas skip wishlisted games', 'ok', coalesce((NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.buy_pool('check.member@example.invalid')) x WHERE (x ->> 'bggId')::int = 224517)), false));
    res := res || jsonb_build_object('what', 'removing from a wishlist', 'ok', coalesce((jsonb_array_length(bgc.wish_change('check.member@example.invalid', 'remove', 224517, '', NULL) -> 'items') = 0), false));
    res := res || jsonb_build_object('what', 'a member can''t open the admin page', 'ok', coalesce((NOT (bgc.admin_overview('check.member@example.invalid') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'Dan can open the admin page', 'ok', coalesce(((bgc.admin_overview('dandehaan@gmail.com') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a member can''t change the question limit', 'ok', coalesce((NOT (bgc.admin_action('check.member@example.invalid', 'askLimit', NULL, '{"value": 99}') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'Dan''s account can''t be removed', 'ok', coalesce((NOT (bgc.admin_action('dandehaan@gmail.com', 'remove', 1, '{}') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a misspelled name finds the game', 'ok', coalesce(((SELECT title FROM games WHERE id = bgc.match_game('Teraforming Mars')) = 'Terraforming Mars'), false));
    res := res || jsonb_build_object('what', 'a partial name finds the game', 'ok', coalesce(((SELECT title FROM games WHERE id = bgc.match_game('Tanares Adventure')) LIKE '%Tanares Adventures'), false));
    res := res || jsonb_build_object('what', 'an exact name finds that game, not an expansion', 'ok', coalesce(((SELECT title FROM games WHERE id = bgc.match_game('Catan')) = 'Catan'), false));
    res := res || jsonb_build_object('what', 'a made-up name finds nothing', 'ok', coalesce((bgc.match_game('Zzqx Not A Real Game') IS NULL), false));
    res := res || jsonb_build_object('what', 'a game not filled in yet isn''t swapped for a similar title', 'ok', coalesce((coalesce((SELECT title FROM games WHERE id = bgc.match_game('Horror on the Orient Express')), '') NOT LIKE '%Dead Man%'), false));
    res := res || jsonb_build_object('what', 'a chat turn is saved', 'ok', coalesce(((bgc.chat_save('check.member@example.invalid', 'check-chat-1', 'something like Catan', '{"pick": {"title": "Catan"}}', '[{"note": "Prefers games under an hour", "replaces": null, "skip": null}, {"note": "Doesn''t want Terraforming Mars suggested", "replaces": null, "skip": "Terraforming Mars"}]') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'Nathan remembers what he learned about you', 'ok', coalesce((jsonb_array_length(bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'notes') = 2), false));
    res := res || jsonb_build_object('what', 'a game you turned down is on your skip list', 'ok', coalesce(((bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'skipBgg') @> to_jsonb((SELECT bgg_id FROM games WHERE title = 'Terraforming Mars'))), false));
    res := res || jsonb_build_object('what', 'Nathan knows what he suggested you lately', 'ok', coalesce(((bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'recentBgg') @> to_jsonb((SELECT bgg_id FROM games WHERE title = 'Catan'))), false));
    res := res || jsonb_build_object('what', 'Nathan sees the chat so far', 'ok', coalesce((jsonb_array_length(bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'turns') = 1), false));
    res := res || jsonb_build_object('what', 'someone else''s chat isn''t yours, even with its key', 'ok', coalesce((jsonb_array_length(bgc.memory_for('dandehaan@gmail.com', 'check-chat-1') -> 'turns') = 0), false));
    res := res || jsonb_build_object('what', 'you can''t open someone else''s chat', 'ok', coalesce((bgc.memory_page('dandehaan@gmail.com', 'check-chat-1') -> 'chat' = 'null'::jsonb OR bgc.memory_page('dandehaan@gmail.com', 'check-chat-1') -> 'chat' ->> 'key' <> 'check-chat-1'), false));
    res := res || jsonb_build_object('what', 'you can ask Nathan to forget everything', 'ok', coalesce(((bgc.memory_forget('check.member@example.invalid', NULL) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', '"Forget everything" deletes your notes and chats', 'ok', coalesce((NOT EXISTS (SELECT 1 FROM chat_turns t JOIN members m ON m.id = t.member_id WHERE m.google_email = 'check.member@example.invalid')
  AND NOT EXISTS (SELECT 1 FROM member_notes n JOIN members m ON m.id = n.member_id WHERE m.google_email = 'check.member@example.invalid')), false));
    res := res || jsonb_build_object('what', 'a rulebook over 60 pages is turned away', 'ok', coalesce(((bgc.rule_doc_stored((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'rulebook', '', NULL) ->> 'id')::bigint, 61, 'check-long') ->> 'status')::int = 413), false));
    res := res || jsonb_build_object('what', 'a rulebook is queued for reading', 'ok', coalesce(((bgc.rule_doc_stored((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'rulebook', '', 'https://example.invalid/catan.pdf') ->> 'id')::bigint, 4, 'check-sha') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'the same PDF twice is recognised', 'ok', coalesce(((bgc.rule_doc_stored((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'reference', '', NULL) ->> 'id')::bigint, 4, 'check-sha') ->> 'duplicate')::boolean), false));
    res := res || jsonb_build_object('what', 'a page Nathan read is saved', 'ok', coalesce(((bgc.rule_page_save((SELECT id FROM rule_docs WHERE sha256 = 'check-sha'), 3, '## Trading', false, '[{"heading": "Trading", "body": "On your turn you may trade resource cards with other players."}]') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a rulebook with unread pages goes back in the queue', 'ok', coalesce(((bgc.rule_doc_finish((SELECT id FROM rule_docs WHERE sha256 = 'check-sha')) ->> 'status') = 'queued'), false));
    UPDATE rule_docs SET status = 'ready' WHERE sha256 = 'check-sha';
    res := res || jsonb_build_object('what', 'a rules question finds the right page', 'ok', coalesce(((bgc.rule_search('["Catan"]', 'can I trade with other players') -> 0 -> 'sections' -> 0 ->> 'page')::int = 3), false));
    res := res || jsonb_build_object('what', 'someone else can''t remove your rulebook', 'ok', coalesce((NOT (bgc.rule_doc_change('nathan.schmidt@curator.invalid', (SELECT id FROM rule_docs WHERE sha256 = 'check-sha'), 'remove', '{}') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a game with a rulebook shows it on every shelf', 'ok', coalesce((bgc.rule_doc_games() @> '[13]'), false));
    res := res || jsonb_build_object('what', 'an AI call''s cost can be recorded', 'ok', coalesce((bgc.log_ai('dandehaan@gmail.com', '[{"feature": "nathan", "model": "check-model", "cost": 0.5}]') IS NULL), false));
    res := res || jsonb_build_object('what', 'the recorded cost is there afterwards', 'ok', coalesce((EXISTS (SELECT 1 FROM ai_costs WHERE model = 'check-model' AND cost = 0.5 AND feature = 'nathan')), false));
    res := res || jsonb_build_object('what', 'only admins see what the site costs', 'ok', coalesce((NOT (bgc.costs_page('check.member@example.invalid') ->> 'ok')::boolean AND (bgc.costs_page('dandehaan@gmail.com') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'a member can send feedback', 'ok', coalesce(((bgc.feedback('check.member@example.invalid', '{"kind": "idea", "mood": 4, "message": "check feedback"}') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'empty feedback is turned away', 'ok', coalesce((NOT (bgc.feedback('check.member@example.invalid', '{}') ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'only admins read feedback', 'ok', coalesce((bgc.feedback_all('check.member@example.invalid') IS NULL AND bgc.feedback_all('dandehaan@gmail.com') -> 'items' -> 0 ->> 'message' = 'check feedback'), false));
    res := res || jsonb_build_object('what', 'a member can''t mark feedback done', 'ok', coalesce((NOT (bgc.feedback('check.member@example.invalid', jsonb_build_object('action', 'status', 'status', 'done', 'id', (SELECT max(id) FROM feedback))) ->> 'ok')::boolean), false));
    res := res || jsonb_build_object('what', 'Dan''s play counts are intact (The Crew: 21)', 'ok', coalesce(((SELECT play_count FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = 1 AND g.title = 'The Crew: The Quest for Planet Nine') = 21), false));
    RAISE EXCEPTION 'self-check done' USING ERRCODE = 'P0001'; -- undo everything the checks did
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'self-check done' THEN res := res || jsonb_build_object('what', 'the checks crashed: ' || SQLERRM, 'ok', false); END IF;
  END;
  RETURN res;
END $$;

COMMIT;
