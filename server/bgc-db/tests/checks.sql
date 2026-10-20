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

-- People lists come from plays (1+), and Matt's counts are intact
SELECT pg_temp.check((SELECT play_count FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = 1 AND g.title = 'The Crew: The Quest for Planet Nine') = 21, 'Dan''s play counts are intact (The Crew: 21)');

ROLLBACK;
