-- The admin dashboard: how people use the site. Nathan's answers are logged by kind and speed only (never the question text).
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 020_dashboard.sql  (safe to re-run)
BEGIN;

CREATE TABLE IF NOT EXISTS ask_log (
  id        bigserial PRIMARY KEY,
  member_id bigint REFERENCES members(id) ON DELETE CASCADE,
  at        timestamptz NOT NULL DEFAULT now(),
  kind      text NOT NULL,           -- recommend, browse, person, game, buy, rules, off-topic
  ms        int,                     -- how long the answer took
  ok        boolean NOT NULL DEFAULT true,
  social    text);                   -- friends (across friends' shelves), visit (at a friend's), or null
CREATE INDEX IF NOT EXISTS ask_log_at ON ask_log (at);

CREATE OR REPLACE FUNCTION bgc.log_ask(email text, kind text, ms int, ok boolean, social text) RETURNS void LANGUAGE sql AS $$
  INSERT INTO ask_log (member_id, kind, ms, ok, social) VALUES (bgc.member_id(email), left(coalesce(nullif(kind, ''), 'other'), 20), ms, coalesce(ok, true), nullif(social, '')) $$;

CREATE OR REPLACE FUNCTION bgc.dashboard(email text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE today date := bgc.ask_day(); tz text := 'America/Detroit';
BEGIN
  IF NOT bgc.is_admin(email) THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Admins only'); END IF;
  RETURN jsonb_build_object('ok', true, 'generatedAt', at.iso(now()), 'askLimit', bgc.ask_limit(),
    'kpis', jsonb_build_object(
      'members', (SELECT count(*) FROM members),
      'activeToday', (SELECT count(*) FROM member_days WHERE day = today),
      'active7', (SELECT count(DISTINCT member_id) FROM member_days WHERE day > today - 7),
      'active30', (SELECT count(DISTINCT member_id) FROM member_days WHERE day > today - 30),
      'avgDaily30', (SELECT round(count(*)::numeric / 30, 1) FROM member_days WHERE day > today - 30),
      'questions7', (SELECT coalesce(sum(questions), 0) FROM ask_usage WHERE day > today - 7),
      'questions30', (SELECT coalesce(sum(questions), 0) FROM ask_usage WHERE day > today - 30),
      'questionsAll', (SELECT coalesce(sum(questions), 0) FROM ask_usage),
      'answerSec7', (SELECT round(avg(ms) / 1000.0, 1) FROM ask_log WHERE at > now() - interval '7 days' AND ok),
      'answerOk30', (SELECT round(100.0 * count(*) FILTER (WHERE ok) / nullif(count(*), 0)) FROM ask_log WHERE at > now() - interval '30 days'),
      'games', (SELECT count(*) FROM shelves),
      'uniqueGames', (SELECT count(DISTINCT game_id) FROM shelves),
      'gamesAdded30', (SELECT count(*) FROM shelves WHERE added_at > now() - interval '30 days'),
      'ratings', (SELECT count(*) FROM ratings),
      'ratings30', (SELECT count(*) FROM ratings WHERE updated_at > now() - interval '30 days'),
      'wishlist', (SELECT count(*) FROM wishlist),
      'friendships', (SELECT count(*) FROM friendships WHERE status = 'accepted'),
      'rulebooks', (SELECT count(*) FROM rulebooks),
      'plays', (SELECT count(*) FROM plays)),
    -- Day by day, last 90 days
    'daily', (SELECT jsonb_agg(jsonb_build_object('day', d::date,
        'active', (SELECT count(*) FROM member_days md WHERE md.day = d::date),
        'visits', (SELECT coalesce(sum(hits), 0) FROM member_days md WHERE md.day = d::date),
        'questions', (SELECT coalesce(sum(questions), 0) FROM ask_usage a WHERE a.day = d::date),
        'gamesAdded', (SELECT count(*) FROM shelves s WHERE (s.added_at AT TIME ZONE tz)::date = d::date),
        'ratings', (SELECT count(*) FROM ratings r WHERE (r.updated_at AT TIME ZONE tz)::date = d::date),
        'wishes', (SELECT count(*) FROM wishlist w WHERE (w.added_at AT TIME ZONE tz)::date = d::date),
        'friendships', (SELECT count(*) FROM friendships f WHERE (f.accepted_at AT TIME ZONE tz)::date = d::date),
        'answerSec', (SELECT round(avg(ms) / 1000.0, 1) FROM ask_log l WHERE (l.at AT TIME ZONE tz)::date = d::date AND l.ok)) ORDER BY d)
      FROM generate_series(today - 89, today, interval '1 day') d),
    -- What people ask Nathan (kinds only) and when
    'askKinds', (SELECT coalesce(jsonb_object_agg(kind, n), '{}') FROM (SELECT kind, count(*) AS n FROM ask_log WHERE at > now() - interval '30 days' GROUP BY kind) k),
    'askSocial', (SELECT coalesce(jsonb_object_agg(social, n), '{}') FROM (SELECT social, count(*) AS n FROM ask_log WHERE at > now() - interval '30 days' AND social IS NOT NULL GROUP BY social) k),
    'askHours', (SELECT jsonb_agg(coalesce((SELECT count(*) FROM ask_log l WHERE l.at > now() - interval '30 days' AND extract(hour FROM l.at AT TIME ZONE tz) = h), 0) ORDER BY h)
      FROM generate_series(0, 23) h),
    'askWeekdays', (SELECT jsonb_agg(coalesce((SELECT count(*) FROM ask_log l WHERE l.at > now() - interval '30 days' AND extract(dow FROM l.at AT TIME ZONE tz) = w), 0) ORDER BY w)
      FROM generate_series(0, 6) w),
    -- Every member, with what they do
    'users', (SELECT coalesce(jsonb_agg(u ORDER BY (u ->> 'score')::numeric DESC), '[]') FROM (
      SELECT jsonb_build_object('id', m.id, 'name', m.display_name, 'isAdmin', m.is_admin, 'demo', m.google_email LIKE '%.invalid',
        'joined', at.iso(m.created_at), 'lastSeen', at.iso(m.last_seen_at),
        'activeDays30', (SELECT count(*) FROM member_days md WHERE md.member_id = m.id AND md.day > today - 30),
        'visits30', (SELECT coalesce(sum(hits), 0) FROM member_days md WHERE md.member_id = m.id AND md.day > today - 30),
        'questions30', (SELECT coalesce(sum(questions), 0) FROM ask_usage a WHERE a.member_id = m.id AND a.day > today - 30),
        'questionsAll', (SELECT coalesce(sum(questions), 0) FROM ask_usage a WHERE a.member_id = m.id),
        'favoriteKind', (SELECT kind FROM ask_log l WHERE l.member_id = m.id GROUP BY kind ORDER BY count(*) DESC LIMIT 1),
        'games', (SELECT count(*) FROM shelves s WHERE s.member_id = m.id),
        'gamesAdded30', (SELECT count(*) FROM shelves s WHERE s.member_id = m.id AND s.added_at > now() - interval '30 days'),
        'plays', (SELECT count(*) FROM plays p WHERE p.owner_id = m.id),
        'ratings', (SELECT count(*) FROM ratings r WHERE r.member_id = m.id),
        'wishlist', (SELECT count(*) FROM wishlist w WHERE w.member_id = m.id),
        'friends', (SELECT count(*) FROM friendships f WHERE f.status = 'accepted' AND m.id IN (f.requester_id, f.addressee_id)),
        'top10', jsonb_array_length(m.top_games),
        'profile', (CASE WHEN m.likes <> '' THEN 1 ELSE 0 END + CASE WHEN m.dislikes <> '' THEN 1 ELSE 0 END + CASE WHEN m.about <> '' THEN 1 ELSE 0 END
          + CASE WHEN m.complexity IS NOT NULL THEN 1 ELSE 0 END),
        'bgg', m.bgg_username,
        -- An overall "how much do they use it" number for ranking the top users
        'score', (SELECT count(*) FROM member_days md WHERE md.member_id = m.id AND md.day > today - 30) * 3
          + (SELECT coalesce(sum(questions), 0) FROM ask_usage a WHERE a.member_id = m.id AND a.day > today - 30) * 2
          + (SELECT count(*) FROM shelves s WHERE s.member_id = m.id AND s.added_at > now() - interval '30 days')
          + (SELECT count(*) FROM ratings r WHERE r.member_id = m.id AND r.updated_at > now() - interval '30 days')) AS u
      FROM members m) x),
    -- The games: across everyone's shelves
    'mostOwned', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'n')::int DESC), '[]') FROM (
      SELECT jsonb_build_object('title', g.title, 'cover', g.cover_card, 'n', count(*), 'who', string_agg(split_part(m.display_name, ' ', 1), ', ' ORDER BY m.display_name)) AS x
      FROM shelves s JOIN games g ON g.id = s.game_id JOIN members m ON m.id = s.member_id GROUP BY g.id HAVING count(*) > 1 ORDER BY count(*) DESC, g.bgg_rank NULLS LAST LIMIT 12) q),
    -- Played by the most people: everyone at the table in any member's logged plays, so one person's hundreds of
    -- games of cribbage don't freeze the list. Ties go to the game with more plays.
    'mostPlayed', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'n')::int DESC, (x ->> 'plays')::int DESC), '[]') FROM (
      SELECT jsonb_build_object('title', g.title, 'cover', g.cover_card, 'n', q.people, 'plays', q.plays) AS x
      FROM (SELECT p.game_id, count(DISTINCT coalesce(pp.player_id::text, 'name:' || lower(btrim(pp.name)))) AS people, count(DISTINCT p.id) AS plays
            FROM plays p JOIN play_players pp ON pp.play_id = p.id WHERE p.game_id IS NOT NULL GROUP BY p.game_id) q
      JOIN games g ON g.id = q.game_id ORDER BY q.people DESC, q.plays DESC LIMIT 12) q),
    'topRated', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'avg')::numeric DESC, (x ->> 'n')::int DESC), '[]') FROM (
      SELECT jsonb_build_object('title', g.title, 'cover', g.cover_card, 'avg', round(avg(r.stars), 2), 'n', count(*)) AS x
      FROM ratings r JOIN games g ON g.id = r.game_id GROUP BY g.id HAVING count(*) >= 2 ORDER BY avg(r.stars) DESC, count(*) DESC LIMIT 12) q),
    'mostWished', (SELECT coalesce(jsonb_agg(x ORDER BY (x ->> 'n')::int DESC), '[]') FROM (
      SELECT jsonb_build_object('title', g.title, 'cover', g.cover_card, 'n', count(*)) AS x
      FROM wishlist w JOIN games g ON g.id = w.game_id GROUP BY g.id ORDER BY count(*) DESC, max(w.added_at) DESC LIMIT 12) q),
    'recentlyAdded', (SELECT coalesce(jsonb_agg(x ORDER BY x ->> 'at' DESC), '[]') FROM (
      SELECT jsonb_build_object('title', g.title, 'cover', g.cover_card, 'who', split_part(m.display_name, ' ', 1), 'at', at.iso(s.added_at)) AS x
      FROM shelves s JOIN games g ON g.id = s.game_id JOIN members m ON m.id = s.member_id ORDER BY s.added_at DESC LIMIT 12) q),
    -- How far along people are with the features
    'adoption', jsonb_build_object(
      'members', (SELECT count(*) FROM members),
      'withGames', (SELECT count(*) FROM members m WHERE EXISTS (SELECT 1 FROM shelves s WHERE s.member_id = m.id)),
      'withPlays', (SELECT count(*) FROM members m WHERE EXISTS (SELECT 1 FROM plays p WHERE p.owner_id = m.id)),
      'withProfile', (SELECT count(*) FROM members WHERE likes <> '' OR about <> '' OR complexity IS NOT NULL),
      'withTop10', (SELECT count(*) FROM members WHERE jsonb_array_length(top_games) > 0),
      'withWishlist', (SELECT count(*) FROM members m WHERE EXISTS (SELECT 1 FROM wishlist w WHERE w.member_id = m.id)),
      'withRatings', (SELECT count(*) FROM members m WHERE EXISTS (SELECT 1 FROM ratings r WHERE r.member_id = m.id)),
      'withFriends', (SELECT count(*) FROM members m WHERE EXISTS (SELECT 1 FROM friendships f WHERE f.status = 'accepted' AND m.id IN (f.requester_id, f.addressee_id))),
      'askedNathan', (SELECT count(DISTINCT member_id) FROM ask_usage)));
END $$;

COMMIT;
