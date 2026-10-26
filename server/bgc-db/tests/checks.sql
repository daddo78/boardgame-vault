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
SELECT pg_temp.check((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'rulebook', 'Another copy', NULL) ->> 'status')::int = 409, 'a game keeps one rulebook: a member''s second is turned away');
SELECT pg_temp.check((bgc.rule_doc_new('check.member@example.invalid', 13, 'Catan', 'aid', '', NULL) ->> 'ok')::boolean, 'a member can still add a player aid next to it');
SELECT pg_temp.check((bgc.rule_doc_new('dandehaan@gmail.com', 13, 'Catan', 'rulebook', 'Replacement', NULL) ->> 'ok')::boolean, 'an admin can add a second rulebook, to replace the first');
SELECT pg_temp.check(bgc.rule_kind_label('learn') = 'Learn to play' AND bgc.rule_kind_label('aid') = 'Player aid', 'the new kinds have names');
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


-- One shelf for everyone (045): the polish after an add fills only blanks; the Players screen and BGG ratings are the database's to guard
SELECT pg_temp.check((bgc.shelf_add('check.member@example.invalid', NULL, 'Check Homemade Game') ->> 'ok')::boolean, 'a member can add a game by title alone');
SELECT pg_temp.check((bgc.game_to_polish('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.title = 'Check Homemade Game')) ->> 'needsIcon')::boolean, 'a game just added needs its icon and blurb');
SELECT pg_temp.check((bgc.polish_game('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.title = 'Check Homemade Game'), '{"genre": "Checks / Tests", "type": "Testing", "desc": "A game for the checks.", "icon": "flask"}') ->> 'icon') = 'flask', 'the polish fills in genre, type, blurb and icon');
SELECT pg_temp.check((bgc.polish_game('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.title = 'Check Homemade Game'), '{"genre": "Other", "icon": "bad icon!"}') ->> 'genre') = 'Checks / Tests', 'the polish never overwrites what is there');
SELECT pg_temp.check((SELECT icon FROM games WHERE title = 'Check Homemade Game') = 'flask', 'a bad icon name is refused');
SELECT pg_temp.check(NOT (bgc.game_to_polish('nathan.schmidt@curator.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.title = 'Check Homemade Game')) ->> 'ok')::boolean, 'nobody polishes a game on someone else''s shelf');
SELECT pg_temp.check(NOT (bgc.players_admin('check.member@example.invalid') ->> 'ok')::boolean AND (bgc.players_admin('dandehaan@gmail.com') ->> 'ok')::boolean, 'only admins see the Players screen');
SELECT pg_temp.check(NOT (bgc.player_save('check.member@example.invalid', NULL, '{"fldWVws64FVcdtuSJ": "Nobody"}') ->> 'ok')::boolean, 'only admins save a player card');
SELECT pg_temp.check((bgc.player_save('dandehaan@gmail.com', NULL, '{"fldWVws64FVcdtuSJ": "Check Player"}') -> 'record' -> 'fields' ->> 'fldWVws64FVcdtuSJ') = 'Check Player', 'an admin can make a player card');
SELECT pg_temp.check(bgc.bgg_ratings_save('check_bgg_user', '[{"bggId": 13, "rating10": 7.5}, {"bggId": "x", "rating10": 9}]') = 1, 'BGG ratings are saved per username, bad rows skipped');
SELECT pg_temp.check(bgc.bgg_ratings_save('check_bgg_user', '[{"bggId": 14, "rating10": 7}, {"bggId": 14, "rating10": 8}]') = 1, 'a game listed twice in a BGG collection (two copies) is saved once');
SELECT pg_temp.check(jsonb_array_length(bgc.bgg_usernames()) >= 1, 'the BGG ratings sync has usernames to fetch');
-- Thumbs on Nathan's replies (047): a member votes, the same thumb again clears it, a note sends the question along, admins read them
-- (a vote and the read of what it stored are separate checks: the two sides of one AND may run in either order)
SELECT pg_temp.check((bgc.ask_vote('check.member@example.invalid', '{"chatKey": "check-chat", "question": "check question", "vote": "up"}') ->> 'vote') = 'up', 'a member can give a reply a thumbs up');
SELECT pg_temp.check((bgc.ask_vote('check.member@example.invalid', '{"chatKey": "check-chat", "question": "check question", "vote": "down", "note": "check note"}') ->> 'note') = 'check note', 'the other thumb changes the vote and takes a note');
SELECT pg_temp.check((SELECT count(*) FROM ask_votes WHERE chat_key = 'check-chat') = 1 AND (SELECT vote FROM ask_votes WHERE chat_key = 'check-chat') = 'down', 'one vote per reply');
SELECT pg_temp.check((SELECT question FROM ask_votes WHERE chat_key = 'check-chat') = 'check question'
  AND bgc.ask_votes_admin('dandehaan@gmail.com') -> 'items' -> 0 ->> 'note' = 'check note', 'with a note, the question goes to Admin → Nathan');
SELECT pg_temp.check((bgc.ask_vote('check.member@example.invalid', '{"chatKey": "check-chat", "question": "check question 2", "vote": "up"}') ->> 'ok')::boolean, 'a thumb alone is accepted');
SELECT pg_temp.check((SELECT question FROM ask_votes WHERE chat_key = 'check-chat' AND question_key = md5('check question 2')) = '', 'a thumb alone keeps no question text');
SELECT pg_temp.check(NOT (bgc.ask_vote('check.member@example.invalid', '{"chatKey": "check-chat", "question": "check question", "vote": "meh"}') ->> 'ok')::boolean, 'a vote that isn''t up or down is turned away');
SELECT pg_temp.check((bgc.ask_vote('check.member@example.invalid', '{"chatKey": "check-chat", "question": "check question", "vote": ""}') ->> 'vote') = '', 'the same thumb again clears a vote');
SELECT pg_temp.check((SELECT count(*) FROM ask_votes WHERE chat_key = 'check-chat') = 1, 'a cleared vote is gone');
SELECT pg_temp.check(bgc.ask_votes_admin('check.member@example.invalid') IS NULL AND (bgc.ask_votes_admin('dandehaan@gmail.com') ->> 'upAll')::int >= 1, 'only admins read the thumbs');

-- Plays logged here and changes sent to BGG (049)
INSERT INTO games (bgg_id, title) VALUES (999901, 'Check BGG Game') ON CONFLICT (bgg_id) DO NOTHING;
SELECT pg_temp.check((bgc.shelf_add('check.member@example.invalid', '{"id": 999901, "name": "Check BGG Game", "type": "boardgame"}', 'Check BGG Game') ->> 'ok')::boolean, 'a game for the BGG checks');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid')), 'nothing goes to BGG for a member who hasn''t linked it');
SELECT pg_temp.check((bgc.log_play('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999901 AND s.member_id = bgc.member_id('check.member@example.invalid')),
  '{"date": "2026-10-19", "players": [{"name": "Check Member"}]}') ->> 'toBgg') = 'false', 'a play logged before linking BGG stays here for now');
SELECT pg_temp.check((bgc.bgg_link_save('check.member@example.invalid', 'check_bgg_user', 'v1.sealed', now() + interval '1 year') -> 'link' ->> 'linked')::boolean, 'linking BGG keeps the sealed token');
SELECT pg_temp.check((SELECT count(*) FROM bgg_outbox o JOIN plays p ON p.id = o.play_id WHERE o.member_id = bgc.member_id('check.member@example.invalid') AND p.played_on = '2026-10-19' AND o.state = 'pending') = 1, 'linking BGG sends the plays it doesn''t have yet');
UPDATE bgg_outbox SET state = 'done' WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'play';
UPDATE plays SET bgg_play_id = 987654320 WHERE owner_id = bgc.member_id('check.member@example.invalid') AND played_on = '2026-10-19';
SELECT pg_temp.check((SELECT bgg_username FROM members WHERE google_email = 'check.member@example.invalid') = 'check_bgg_user', 'linking makes it the username plays sync from');
SELECT pg_temp.check((bgc.log_play('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999901 AND s.member_id = bgc.member_id('check.member@example.invalid')),
  '{"date": "2026-10-20", "minutes": 45, "players": [{"name": "Check Member", "win": true}, {"name": "Check Newcomer"}]}') ->> 'playCount')::int = 2, 'a play logged here counts right away');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Newcomer'), 'a new name in a play becomes one of your people');
SELECT pg_temp.check((SELECT count(*) FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'play' AND state = 'pending') = 1, 'a linked member''s play waits to go to BGG');
SELECT pg_temp.check(NOT (bgc.log_play('nathan.schmidt@curator.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999901 AND s.member_id = bgc.member_id('check.member@example.invalid')), '{"date": "2026-10-20", "players": [{"name": "X"}]}') ->> 'ok')::boolean, 'nobody logs a play on someone else''s shelf');
SELECT pg_temp.check((bgc.rate('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999901 AND s.member_id = bgc.member_id('check.member@example.invalid')), 3) ->> 'ok')::boolean, 'rate a game (whole star)');
SELECT pg_temp.check((bgc.rate('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999901 AND s.member_id = bgc.member_id('check.member@example.invalid')), 3.5) ->> 'stars')::numeric = 3.5, 'and again, in halves');
SELECT pg_temp.check((SELECT want FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND bgg_id = 999901 AND kind = 'item' AND state = 'pending') = '{"rating10": 7.0}'::jsonb, 'one waiting change per game: the last rating (3.5 stars = 7 on BGG); the add came before linking');
SELECT pg_temp.check(jsonb_array_length(bgc.bgg_out_next(10)) >= 2, 'the worker sees what''s waiting');
SELECT pg_temp.check(bgc.bgg_out_result((SELECT id FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'play' AND state = 'pending'), '{"outcome": "ok", "bggPlayId": 987654321}'), 'BGG took the play');
SELECT pg_temp.check((SELECT bgg_play_id FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND bgg_id = 999901 AND played_on = '2026-10-20') = 987654321, 'a play sent to BGG gets BGG''s id, so the nightly sync updates it instead of adding another');
SELECT pg_temp.check(bgc.bgg_out_result((SELECT id FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'item' AND state = 'pending'), '{"outcome": "auth", "message": "You must login"}'), 'BGG asks for a new sign-in');
SELECT pg_temp.check((bgc.bgg_link_status('check.member@example.invalid') ->> 'state') = 'expired' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.bgg_out_next(50)) x WHERE (x ->> 'memberId')::bigint = bgc.member_id('check.member@example.invalid')), 'when BGG wants a new sign-in, the member''s changes wait for it');
SELECT pg_temp.check((bgc.bgg_link_save('check.member@example.invalid', 'check_bgg_user', 'v1.sealed2', NULL) -> 'link' ->> 'state') = 'ok', 'signing in again picks them up');
-- Logged here and also on BG Stats: the BGG copy stays, ours goes
SELECT pg_temp.check((bgc.log_play('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999901 AND s.member_id = bgc.member_id('check.member@example.invalid')), '{"date": "2026-10-21", "players": [{"name": "Check Member"}]}') ->> 'ok')::boolean, 'a second play, logged here');
SELECT pg_temp.check((at.save_plays('check.member@example.invalid', '[{"id": 987654322, "date": "2026-10-21", "bggId": 999901, "gameName": "Check BGG Game", "quantity": 1, "players": [{"seat": 1, "name": "check member"}]}]') ->> 'newPlays')::int = 1, 'the same play arrives from BGG');
SELECT pg_temp.check(bgc.merge_site_plays('check.member@example.invalid') = 1, 'a play logged here and on BGG becomes one');
SELECT pg_temp.check((SELECT count(*) FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND played_on = '2026-10-21') = 1
  AND NOT EXISTS (SELECT 1 FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'play' AND state = 'pending'), 'and isn''t sent to BGG a second time');
SELECT pg_temp.check(bgc.merge_site_plays('check.member@example.invalid') = 0, 'a play posted from here isn''t its own duplicate');
-- BGG's ratings become a linked member's stars, and aren't sent back
UPDATE bgg_outbox SET state = 'done' WHERE member_id = bgc.member_id('check.member@example.invalid') AND state = 'pending';
SELECT pg_temp.check(bgc.bgg_ratings_save('check_bgg_user', '[{"bggId": 999901, "rating10": 8.6}]') = 1, 'a BGG rating for the game');
SELECT pg_temp.check(bgc.stars_from_bgg('check_bgg_user') >= 1, 'BGG ratings fill in a linked member''s stars');
SELECT pg_temp.check((SELECT stars FROM ratings WHERE member_id = bgc.member_id('check.member@example.invalid') AND game_id = (SELECT id FROM games WHERE bgg_id = 999901)) = 4.5, 'a BGG rating of 8.6 is 4.5 stars');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND state = 'pending'), 'stars that came from BGG aren''t sent back to it');
SELECT pg_temp.check((bgc.shelf_remove('check.member@example.invalid', (SELECT s.legacy_id FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999901 AND s.member_id = bgc.member_id('check.member@example.invalid'))) ->> 'ok')::boolean, 'remove the game');
SELECT pg_temp.check((SELECT want ->> 'own' FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND state = 'pending') = 'false', 'removing a game from the shelf takes it out of what you own on BGG');
SELECT pg_temp.check((bgc.log_play('check.member@example.invalid', NULL, '{"bggId": 999902, "title": "Check Friend Game", "date": "2026-10-22", "location": " Check Cafe ", "players": [{"name": "Check Member"}]}') ->> 'ok')::boolean, 'a play of a game you don''t own');
SELECT pg_temp.check((SELECT count(*) FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND bgg_id = 999902) = 1
  AND NOT EXISTS (SELECT 1 FROM shelves s JOIN games g ON g.id = s.game_id WHERE g.bgg_id = 999902), 'is kept without putting the game on your shelf');
SELECT pg_temp.check(bgc.my_plays('check.member@example.invalid', 0, 50) -> 'plays' -> 0 ->> 'title' = 'Check Friend Game', 'your plays, newest first');
SELECT pg_temp.check(bgc.my_plays('check.member@example.invalid', 0, 50) -> 'plays' -> 0 ->> 'location' = 'Check Cafe', 'with where it was played');
SELECT pg_temp.check(bgc.play_places('check.member@example.invalid') ? 'Check Cafe', 'and the place is suggested next time');
-- Merging two names for one person or place (050)
SELECT pg_temp.check((bgc.person_save('check.member@example.invalid', NULL, '{"name": "Check Joan"}') ->> 'ok')::boolean, 'Check Joan');
SELECT pg_temp.check((bgc.log_play('check.member@example.invalid', NULL, '{"bggId": 999902, "title": "Check Friend Game", "date": "2026-10-17", "location": "Check Caf", "players": [{"name": "Check Jo"}]}') ->> 'ok')::boolean, 'a play with Check Jo at Check Caf');
UPDATE play_players SET color = 'Blue', start_position = '2' WHERE name = 'Check Jo';
SELECT pg_temp.check((bgc.person_merge('check.member@example.invalid', (SELECT legacy_id FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Jo'),
  (SELECT legacy_id FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Joan')) ->> 'ok')::boolean, 'merge Check Jo into Check Joan');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Jo')
  AND (SELECT aliases FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Joan') = ARRAY['Check Jo'], 'Check Jo is now another name of Check Joan');
SELECT pg_temp.check((SELECT string_agg(pp.name || '/' || pp.color, ',') FROM play_players pp JOIN plays p ON p.id = pp.play_id WHERE p.owner_id = bgc.member_id('check.member@example.invalid') AND p.played_on = '2026-10-17') = 'Check Joan/Blue', 'her play moved over, color and all');
SELECT pg_temp.check(NOT (bgc.person_merge('check.member@example.invalid', (SELECT legacy_id FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND linked_member_id = bgc.member_id('check.member@example.invalid')),
  (SELECT legacy_id FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Joan')) ->> 'ok')::boolean, 'you can''t be merged into someone else');
SELECT pg_temp.check((bgc.place_merge('check.member@example.invalid', 'check caf', 'Check Cafe') ->> 'moved')::int = 1, 'merge a place: its plays move');
SELECT pg_temp.check((SELECT location FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND played_on = '2026-10-17') = 'Check Cafe'
  AND (SELECT aliases FROM places WHERE member_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Cafe') = ARRAY['check caf'], 'and its old name is kept');
UPDATE plays SET location = 'Check Caf' WHERE owner_id = bgc.member_id('check.member@example.invalid') AND played_on = '2026-10-17';
SELECT pg_temp.check(bgc.apply_place_aliases('check.member@example.invalid') = 1, 'a play synced from BGG under the old name moves too');
-- Editing a play (050)
SELECT pg_temp.check((bgc.play_edit('check.member@example.invalid', (SELECT id FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND bgg_id = 999902 AND played_on = '2026-10-22'),
  '{"date": "2026-10-21", "minutes": 50, "location": "Check Cafe", "players": [{"name": "Check Member", "win": true}, {"name": "Check Pal 2"}]}') -> 'play' ->> 'minutes')::int = 50, 'change a play logged here');
SELECT pg_temp.check((SELECT string_agg(pp.name || ':' || pp.win, ',' ORDER BY pp.seat) FROM play_players pp JOIN plays p ON p.id = pp.play_id WHERE p.owner_id = bgc.member_id('check.member@example.invalid') AND p.bgg_id = 999902 AND p.played_on = '2026-10-21') = 'Check Member:true,Check Pal 2:false', 'with its people and winner');
SELECT pg_temp.check(NOT (bgc.play_get('nathan.schmidt@curator.invalid', (SELECT id FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND bgg_id = 999902 AND played_on = '2026-10-21')) ->> 'ok')::boolean, 'nobody opens someone else''s play');
SELECT pg_temp.check(NOT (bgc.play_delete('nathan.schmidt@curator.invalid', (SELECT id FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND bgg_id = 999902 AND played_on = '2026-10-21')) ->> 'ok')::boolean, 'nobody deletes someone else''s play');
SELECT pg_temp.check((bgc.play_delete('check.member@example.invalid', (SELECT id FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND bgg_id = 999902 AND played_on = '2026-10-21')) ->> 'ok')::boolean, 'delete a play logged here');
SELECT pg_temp.check((bgc.play_delete('check.member@example.invalid', (SELECT id FROM plays WHERE owner_id = bgc.member_id('check.member@example.invalid') AND bgg_play_id = 987654321)) ->> 'fromBgg')::boolean, 'delete a play that is on BGG');
SELECT pg_temp.check((SELECT want ->> 'bggPlayId' FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'unplay') = '987654321', 'and it is deleted on BGG too');
UPDATE bgg_outbox SET state = 'done' WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'unplay';
-- Your people and places (050)
SELECT pg_temp.check((bgc.person_save('check.member@example.invalid', NULL, '{"name": "Check Pal", "aliases": ["Pal", "check pal"], "bggUsername": " "}') -> 'person' ->> 'name') = 'Check Pal', 'add one of your people');
SELECT pg_temp.check((SELECT aliases FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Pal') = ARRAY['Pal'], 'other names, without the name itself');
SELECT pg_temp.check(NOT (bgc.person_save('check.member@example.invalid', NULL, '{"name": "check pal"}') ->> 'ok')::boolean, 'no two people with one name');
SELECT pg_temp.check((bgc.log_play('check.member@example.invalid', NULL, '{"bggId": 999903, "title": "Check Third Game", "date": "2026-10-18", "players": [{"name": "Check Regular"}]}') ->> 'ok')::boolean, 'a play with Check Regular');
SELECT pg_temp.check(EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.my_people('check.member@example.invalid') -> 'people') x WHERE x ->> 'name' = 'Check Regular' AND (x ->> 'plays')::int = 1), 'your people, with their plays');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM jsonb_array_elements(bgc.my_people('check.member@example.invalid') -> 'people') x WHERE x ? 'googleEmail'), 'a member never sees emails in their people');
SELECT pg_temp.check(NOT (bgc.person_remove('check.member@example.invalid', (SELECT legacy_id FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Regular')) ->> 'ok')::boolean, 'someone in your plays can''t be removed');
SELECT pg_temp.check((bgc.person_remove('check.member@example.invalid', (SELECT legacy_id FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Pal')) ->> 'ok')::boolean, 'someone with no plays can');
SELECT pg_temp.check(NOT (bgc.person_save('nathan.schmidt@curator.invalid', (SELECT legacy_id FROM players WHERE owner_id = bgc.member_id('check.member@example.invalid') AND name = 'Check Regular'), '{"name": "Hacked"}') ->> 'ok')::boolean, 'nobody changes someone else''s people');
SELECT pg_temp.check((bgc.place_save('check.member@example.invalid', '{"action": "add", "name": "Check Library"}') -> 'places') @> '[{"name": "Check Library", "saved": true}]', 'save a place');
SELECT pg_temp.check(bgc.play_places('check.member@example.invalid') ->> 0 IN ('Check Library', 'Check Cafe') AND (bgc.play_places('check.member@example.invalid') ->> 1) IN ('Check Library', 'Check Cafe'), 'saved places come first in Where');
SELECT pg_temp.check(NOT (bgc.place_save('check.member@example.invalid', '{"action": "remove", "name": "check library"}') -> 'places') @> '[{"name": "Check Library"}]', 'remove a place');
UPDATE bgg_outbox SET state = 'done' WHERE member_id = bgc.member_id('check.member@example.invalid') AND kind = 'play' AND state = 'pending';
SELECT pg_temp.check((bgc.bgg_link_settings('check.member@example.invalid', '{"collection": false}') -> 'link' ->> 'collection') = 'false', 'collection sync can be switched off');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND state = 'pending'), 'switching it off drops what was waiting under it');
SELECT pg_temp.check((bgc.wish_change('check.member@example.invalid', 'add', 999901, 'Check BGG Game', NULL) ->> 'ok')::boolean, 'wish for a game');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND state = 'pending'), 'with collection sync off, a wish stays here');
SELECT pg_temp.check((bgc.bgg_link_remove('check.member@example.invalid') -> 'link' ->> 'linked') = 'false', 'unlink BGG');
SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM bgg_outbox WHERE member_id = bgc.member_id('check.member@example.invalid') AND state = 'pending'), 'unlinking forgets the token and what was waiting');

ROLLBACK;
