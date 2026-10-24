-- Fast checks of the rules that matter (membership, privacy, ratings, wishlists, admin, game matching).
-- Everything runs in a transaction that is rolled back, so nothing is left behind.
-- Run: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 -q < checks.sql   (prints PASS lines; stops at the first FAIL)
BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.check(ok boolean, what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL: %', what; END IF;
  RAISE NOTICE 'PASS: %', what;
END $$;

-- Test people: a member who isn't in Dan's plays, and a stranger who isn't a member
INSERT INTO members (google_email, display_name) VALUES ('check.member@example.invalid', 'Check Member');

-- Sign-in: membership comes from the member list
SELECT pg_temp.check((bgc.sign_in('check.member@example.invalid') ->> 'member')::boolean, 'a member who isn''t in Dan''s plays can sign in');
SELECT pg_temp.check(NOT (bgc.sign_in('stranger@example.invalid') ->> 'member')::boolean, 'a stranger can''t sign in');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM players p JOIN members m ON m.id = p.linked_member_id
  WHERE p.owner_id = at.admin_id() AND m.google_email = 'check.member@example.invalid'), 'signing in doesn''t add someone to Dan''s people');
SELECT pg_temp.check((bgc.sign_in('dandehaan@gmail.com') ->> 'isAdmin')::boolean, 'Dan signs in as an admin');

-- Shelves: everyone's home is their own; friends' shelves only for friends
SELECT pg_temp.check(bgc.shelf_view('check.member@example.invalid', 'main', NULL) ->> 'shelf' = 'mine', 'a member''s "main" is their own shelf');
SELECT pg_temp.check(bgc.shelf_view('check.member@example.invalid', 'friend:1', NULL) ->> 'shelf' = 'mine', 'a non-friend can''t view Dan''s shelf through Nathan');
SELECT pg_temp.check(NOT (bgc.friend_shelf('check.member@example.invalid', 1) ->> 'ok')::boolean, 'a non-friend can''t open Dan''s shelf');
SELECT pg_temp.check(NOT (bgc.profile_page('check.member@example.invalid', 1) ->> 'ok')::boolean, 'a non-friend can''t see Dan''s profile page');
SELECT pg_temp.check(NOT (bgc.wishlist('check.member@example.invalid', 1) ->> 'ok')::boolean, 'a non-friend can''t see Dan''s wishlist');
SELECT pg_temp.check(bgc.shelf_view('dandehaan@gmail.com', 'main', NULL) ->> 'shelf' = 'main', 'Dan''s home is the main collection');
SELECT pg_temp.check((bgc.friend_shelf('nathan.schmidt@curator.invalid', 1) ->> 'ok')::boolean, 'a friend can open Dan''s shelf');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.friend_shelf('nathan.schmidt@curator.invalid', 1) -> 'records') r
  WHERE (r -> 'fields' ->> 'fldskzh1rq9uchgYI')::boolean), 'a friend never sees Dan''s give-away list');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.shelf_view('nathan.schmidt@curator.invalid', 'friend:1', NULL) -> 'players') p
  WHERE p -> 'fields' ? 'fldnwPL9Z33JcXoj2'), 'a friend never sees anyone''s email in the people list');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.shelf_view('dandehaan@gmail.com', 'main', NULL) -> 'players') p
  WHERE p -> 'fields' ? 'fldnwPL9Z33JcXoj2'), 'the owner still gets emails for the Players screen');

-- Friend codes connect both ways
SELECT pg_temp.check((bgc.add_friend('check.member@example.invalid', (SELECT friend_code FROM members WHERE id = 1)) ->> 'ok')::boolean, 'entering a friend code connects');
SELECT pg_temp.check((bgc.friend_shelf('check.member@example.invalid', 1) ->> 'ok')::boolean, 'after connecting, the new friend can open Dan''s shelf');
SELECT pg_temp.check(bgc.friend_by_name('dandehaan@gmail.com', 'Check') = bgc.member_id('check.member@example.invalid'), '"at Check''s" finds the friend by first name');

-- Ratings are yours, on any shelf you can see
SELECT pg_temp.check((bgc.rate('check.member@example.invalid', (SELECT legacy_id FROM shelves WHERE member_id = 1 ORDER BY num LIMIT 1), 4) ->> 'ok')::boolean, 'a friend can rate a game on Dan''s shelf');
SELECT pg_temp.check((SELECT stars FROM ratings WHERE member_id = bgc.member_id('check.member@example.invalid')) = 4, 'the rating is saved on their own account');
SELECT pg_temp.check((bgc.rate('check.member@example.invalid', (SELECT legacy_id FROM shelves WHERE member_id = 1 ORDER BY num LIMIT 1), 0) ->> 'ok')::boolean, 'clearing a rating is accepted');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM ratings WHERE member_id = bgc.member_id('check.member@example.invalid')), 'rating 0 clears it');

-- Wishlists
SELECT pg_temp.check(jsonb_array_length(bgc.wish_change('check.member@example.invalid', 'add', 224517, 'Brass: Birmingham', NULL) -> 'items') = 1, 'adding to a wishlist');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.buy_pool('check.member@example.invalid')) x WHERE (x ->> 'bggId')::int = 224517), 'buy ideas skip wishlisted games');
SELECT pg_temp.check(jsonb_array_length(bgc.wish_change('check.member@example.invalid', 'remove', 224517, '', NULL) -> 'items') = 0, 'removing from a wishlist');

-- Admin tools are admins only
SELECT pg_temp.check(NOT (bgc.admin_overview('check.member@example.invalid') ->> 'ok')::boolean, 'a member can''t open the admin page');
SELECT pg_temp.check((bgc.admin_overview('dandehaan@gmail.com') ->> 'ok')::boolean, 'Dan can open the admin page');
SELECT pg_temp.check(NOT (bgc.admin_action('check.member@example.invalid', 'askLimit', NULL, '{"value": 99}') ->> 'ok')::boolean, 'a member can''t change the question limit');
SELECT pg_temp.check(NOT (bgc.admin_action('dandehaan@gmail.com', 'remove', 1, '{}') ->> 'ok')::boolean, 'Dan''s account can''t be removed');

-- Finding games by name
SELECT pg_temp.check((SELECT title FROM games WHERE id = bgc.match_game('Teraforming Mars')) = 'Terraforming Mars', 'a misspelled name finds the game');
SELECT pg_temp.check((SELECT title FROM games WHERE id = bgc.match_game('Tanares Adventure')) LIKE '%Tanares Adventures', 'a partial name finds the game');
SELECT pg_temp.check((SELECT title FROM games WHERE id = bgc.match_game('Catan')) = 'Catan', 'an exact name finds that game, not an expansion');
SELECT pg_temp.check(bgc.match_game('Zzqx Not A Real Game') IS NULL, 'a made-up name finds nothing');
SELECT pg_temp.check(coalesce((SELECT title FROM games WHERE id = bgc.match_game('Horror on the Orient Express')), '') NOT LIKE '%Dead Man%', 'a game not filled in yet isn''t swapped for a similar title');

-- Nathan's memory: chats and notes are private to each member, and a turned-down game is skipped
SELECT pg_temp.check((bgc.chat_save('check.member@example.invalid', 'check-chat-1', 'something like Catan', '{"pick": {"title": "Catan"}}', '[{"note": "Prefers games under an hour", "replaces": null, "skip": null}, {"note": "Doesn''t want Terraforming Mars suggested", "replaces": null, "skip": "Terraforming Mars"}]') ->> 'ok')::boolean, 'a chat turn is saved');
SELECT pg_temp.check(jsonb_array_length(bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'notes') = 2, 'Nathan remembers what he learned about you');
SELECT pg_temp.check((bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'skipBgg') @> to_jsonb((SELECT bgg_id FROM games WHERE title = 'Terraforming Mars')), 'a game you turned down is on your skip list');
SELECT pg_temp.check((bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'recentBgg') @> to_jsonb((SELECT bgg_id FROM games WHERE title = 'Catan')), 'Nathan knows what he suggested you lately');
SELECT pg_temp.check(jsonb_array_length(bgc.memory_for('check.member@example.invalid', 'check-chat-1') -> 'turns') = 1, 'Nathan sees the chat so far');
SELECT pg_temp.check(jsonb_array_length(bgc.memory_for('dandehaan@gmail.com', 'check-chat-1') -> 'turns') = 0, 'someone else''s chat isn''t yours, even with its key');
SELECT pg_temp.check(bgc.memory_page('dandehaan@gmail.com', 'check-chat-1') -> 'chat' = 'null'::jsonb OR bgc.memory_page('dandehaan@gmail.com', 'check-chat-1') -> 'chat' ->> 'key' <> 'check-chat-1', 'you can''t open someone else''s chat');
SELECT pg_temp.check((bgc.memory_forget('check.member@example.invalid', NULL) ->> 'ok')::boolean, 'you can ask Nathan to forget everything');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM chat_turns t JOIN members m ON m.id = t.member_id WHERE m.google_email = 'check.member@example.invalid')
  AND NOT EXISTS (SELECT 1 FROM member_notes n JOIN members m ON m.id = n.member_id WHERE m.google_email = 'check.member@example.invalid'), '"Forget everything" deletes your notes and chats');

-- Rulebooks: limits, the same file twice, search with page numbers, and who may change one
SELECT pg_temp.check((bgc.rule_doc_stored((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'rulebook', '', NULL) ->> 'id')::bigint, 61, 'check-long') ->> 'status')::int = 413, 'a rulebook over 60 pages is turned away');
SELECT pg_temp.check((bgc.rule_doc_stored((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'rulebook', '', 'https://example.invalid/catan.pdf') ->> 'id')::bigint, 4, 'check-sha') ->> 'ok')::boolean, 'a rulebook is queued for reading');
SELECT pg_temp.check((bgc.rule_doc_stored((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'reference', '', NULL) ->> 'id')::bigint, 4, 'check-sha') ->> 'duplicate')::boolean, 'the same PDF twice is recognised');
SELECT pg_temp.check((bgc.rule_page_save((SELECT id FROM rule_docs WHERE sha256 = 'check-sha'), 3, '## Trading', false, '[{"heading": "Trading", "body": "On your turn you may trade resource cards with other players."}]') ->> 'ok')::boolean, 'a page Nathan read is saved');
SELECT pg_temp.check((bgc.rule_doc_finish((SELECT id FROM rule_docs WHERE sha256 = 'check-sha')) ->> 'status') = 'queued', 'a rulebook with unread pages goes back in the queue');
UPDATE rule_docs SET status = 'ready' WHERE sha256 = 'check-sha';
SELECT pg_temp.check((bgc.rule_search('["Catan"]', 'can I trade with other players') -> 0 -> 'sections' -> 0 ->> 'page')::int = 3, 'a rules question finds the right page');
SELECT pg_temp.check(NOT (bgc.rule_doc_change('nathan.schmidt@curator.invalid', (SELECT id FROM rule_docs WHERE sha256 = 'check-sha'), 'remove', '{}') ->> 'ok')::boolean, 'someone else can''t remove your rulebook');
SELECT pg_temp.check(NOT (bgc.rule_doc_change('check.member@example.invalid', (SELECT id FROM rule_docs WHERE sha256 = 'check-sha'), 'edit', '{"kind": "faq"}') ->> 'ok')::boolean, 'only admins change a rulebook, not the member who added it');
SELECT pg_temp.check(bgc.rule_doc_games() @> '[13]', 'a game with a rulebook shows it on every shelf');
SELECT pg_temp.check((bgc.rule_doc_autoname((SELECT id FROM rule_docs WHERE sha256 = 'check-sha'), 'expansion', 'The Seafarers') ->> 'title') = 'The Seafarers', 'a rulebook left unnamed gets the name found on its pages');
SELECT pg_temp.check((bgc.rule_doc_autoname((SELECT id FROM rule_docs WHERE sha256 = 'check-sha'), 'faq', 'Something else') ->> 'title') = 'The Seafarers', 'a name already there is never replaced');
SELECT pg_temp.check((SELECT kind FROM rule_docs WHERE sha256 = 'check-sha') = 'expansion', 'a type left on Rulebook is corrected once, then kept');

-- Costs: an AI call's cost is recorded, and only admins see the Costs page
SELECT pg_temp.check(bgc.log_ai('dandehaan@gmail.com', '[{"feature": "nathan", "model": "check-model", "cost": 0.5}]') IS NULL, 'an AI call''s cost can be recorded');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM ai_costs WHERE model = 'check-model' AND cost = 0.5 AND feature = 'nathan'), 'the recorded cost is there afterwards');
SELECT pg_temp.check(NOT (bgc.costs_page('check.member@example.invalid') ->> 'ok')::boolean AND (bgc.costs_page('dandehaan@gmail.com') ->> 'ok')::boolean, 'only admins see what the site costs');

-- Expansions: the owner can remove one from a game on their shelf
SELECT pg_temp.check((bgc.shelf_update('dandehaan@gmail.com', (SELECT legacy_id FROM shelves WHERE member_id = 1 AND cardinality(expansions) > 1 ORDER BY legacy_id LIMIT 1),
  jsonb_build_object('expansions', (SELECT to_jsonb(expansions[2:]) FROM shelves WHERE member_id = 1 AND cardinality(expansions) > 1 ORDER BY legacy_id LIMIT 1))) ->> 'ok')::boolean, 'removing an expansion is saved');

-- Feedback: members send it, only admins read it or change its status
SELECT pg_temp.check((bgc.feedback('check.member@example.invalid', '{"kind": "idea", "mood": 4, "message": "check feedback"}') ->> 'ok')::boolean, 'a member can send feedback');
SELECT pg_temp.check(NOT (bgc.feedback('check.member@example.invalid', '{}') ->> 'ok')::boolean, 'empty feedback is turned away');
SELECT pg_temp.check(bgc.feedback_all('check.member@example.invalid') IS NULL AND bgc.feedback_all('dandehaan@gmail.com') -> 'items' -> 0 ->> 'message' = 'check feedback', 'only admins read feedback');
SELECT pg_temp.check(NOT (bgc.feedback('check.member@example.invalid', jsonb_build_object('action', 'status', 'status', 'done', 'id', (SELECT max(id) FROM feedback))) ->> 'ok')::boolean, 'a member can''t mark feedback done');

-- People lists come from plays (1+), and Matt's counts are intact
SELECT pg_temp.check((SELECT play_count FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = 1 AND g.title = 'The Crew: The Quest for Planet Nine') = 21, 'Dan''s play counts are intact (The Crew: 21)');

ROLLBACK;
