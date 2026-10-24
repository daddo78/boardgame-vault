-- Nathan gets to know you: conversations are kept (6 months), and what he learns about you is kept as short notes
-- you can see and delete on your profile. The admin dashboard still shows only kinds of questions, never the text.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 023_chat_memory.sql  (apply once via apply.sh)
BEGIN;

-- One row per question and answer. A conversation is the turns that share a chat_key (the page starts a new one with "New chat").
CREATE TABLE IF NOT EXISTS chat_turns (
  id        bigserial PRIMARY KEY,
  member_id bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  chat_key  text NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  question  text NOT NULL,
  answer    jsonb NOT NULL,                 -- what the page showed, so the chat can be shown again
  pick_bgg  integer[] NOT NULL DEFAULT '{}' -- the games Nathan recommended, so he can vary his picks
);
CREATE INDEX IF NOT EXISTS chat_turns_member ON chat_turns (member_id, at DESC);
CREATE INDEX IF NOT EXISTS chat_turns_chat ON chat_turns (member_id, chat_key, at);
CREATE INDEX IF NOT EXISTS chat_turns_at ON chat_turns (at);

-- What Nathan has learned about someone ("prefers games under 90 minutes on weeknights"); skip_bgg: a game they don't want suggested
CREATE TABLE IF NOT EXISTS member_notes (
  id         bigserial PRIMARY KEY,
  member_id  bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  note       text NOT NULL,
  skip_bgg   integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS member_notes_member ON member_notes (member_id, updated_at DESC);

-- A turn in a line, for Nathan's "earlier in this chat"
CREATE OR REPLACE FUNCTION bgc.turn_brief(a jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('; ',
    CASE WHEN a -> 'pick' ->> 'title' IS NOT NULL THEN 'picked ' || (a -> 'pick' ->> 'title') END,
    CASE WHEN a -> 'alternative' ->> 'title' IS NOT NULL THEN 'alternative ' || (a -> 'alternative' ->> 'title') END,
    CASE WHEN jsonb_typeof(a -> 'highlights') = 'array' AND jsonb_array_length(a -> 'highlights') > 0
      THEN 'highlighted ' || (SELECT string_agg(h ->> 'title', ', ') FROM jsonb_array_elements(a -> 'highlights') h) END,
    left(a ->> 'summary', 300), left(a ->> 'note', 200), left(a -> 'gap' ->> 'missing', 200)) $$;

-- Everything Nathan needs to remember when you ask: your notes, games to skip, what he suggested lately, and this chat so far
CREATE OR REPLACE FUNCTION bgc.memory_for(email text, chat_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id)
  SELECT jsonb_build_object(
    'notes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'note', n.note) ORDER BY n.updated_at DESC)
      FROM member_notes n WHERE n.member_id = me.id), '[]'),
    'skipBgg', coalesce((SELECT jsonb_agg(DISTINCT n.skip_bgg) FROM member_notes n WHERE n.member_id = me.id AND n.skip_bgg IS NOT NULL), '[]'),
    'recentBgg', coalesce((SELECT jsonb_agg(DISTINCT b) FROM chat_turns t, unnest(t.pick_bgg) b
      WHERE t.member_id = me.id AND t.at > now() - interval '14 days'), '[]'),
    -- This chat so far: how it started, and the latest five turns
    'turns', coalesce((SELECT jsonb_agg(jsonb_build_object('q', x.question, 'a', bgc.turn_brief(x.answer)) ORDER BY x.at)
      FROM (SELECT * FROM chat_turns t WHERE t.id IN (
        (SELECT id FROM chat_turns WHERE member_id = me.id AND chat_turns.chat_key = memory_for.chat_key ORDER BY at LIMIT 1)
        UNION (SELECT id FROM chat_turns WHERE member_id = me.id AND chat_turns.chat_key = memory_for.chat_key ORDER BY at DESC LIMIT 5))) x), '[]'))
  FROM me $$;

-- Save a question and answer, and apply what Nathan learned: [{note, replaces (a note id) or null, skip (a game title) or null}]
CREATE OR REPLACE FUNCTION bgc.chat_save(email text, chat_key text, question text, answer jsonb, learn jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); k text := coalesce(nullif(left(chat_key, 64), ''), gen_random_uuid()::text); l jsonb; skip int; txt text; rid bigint;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false); END IF;
  INSERT INTO chat_turns (member_id, chat_key, question, answer, pick_bgg)
  VALUES (me, k, left(question, 500), coalesce(answer, '{}'), coalesce((SELECT array_agg(DISTINCT g.bgg_id) FROM games g
    WHERE g.bgg_id IS NOT NULL AND lower(g.title) IN (SELECT lower(t) FROM (
      SELECT answer -> 'pick' ->> 'title' AS t UNION ALL SELECT answer -> 'alternative' ->> 'title'
      UNION ALL SELECT h ->> 'title' FROM jsonb_array_elements(CASE WHEN answer ->> 'mode' = 'buy' AND jsonb_typeof(answer -> 'highlights') = 'array' THEN answer -> 'highlights' ELSE '[]' END) h) q
      WHERE t IS NOT NULL)), '{}'));
  FOR l IN SELECT * FROM jsonb_array_elements(CASE WHEN jsonb_typeof(learn) = 'array' THEN learn ELSE '[]' END) LIMIT 3 LOOP
    txt := btrim(left(l ->> 'note', 160));
    CONTINUE WHEN txt IS NULL OR length(txt) < 4;
    skip := CASE WHEN nullif(l ->> 'skip', '') IS NOT NULL THEN (SELECT bgg_id FROM games WHERE id = bgc.match_game(l ->> 'skip')) END;
    rid := CASE WHEN l ->> 'replaces' ~ '^\d+$' THEN (l ->> 'replaces')::bigint END;
    IF rid IS NOT NULL AND EXISTS (SELECT 1 FROM member_notes WHERE id = rid AND member_id = me) THEN
      UPDATE member_notes SET note = txt, skip_bgg = skip, updated_at = now() WHERE id = rid;
    ELSIF NOT EXISTS (SELECT 1 FROM member_notes WHERE member_id = me AND (lower(note) = lower(txt) OR (skip IS NOT NULL AND skip_bgg = skip))) THEN
      INSERT INTO member_notes (member_id, note, skip_bgg) VALUES (me, txt, skip);
    END IF;
  END LOOP;
  -- At most 30 notes each (the oldest go first), and conversations older than 6 months are deleted
  DELETE FROM member_notes WHERE member_id = me AND id NOT IN (SELECT id FROM member_notes WHERE member_id = me ORDER BY updated_at DESC LIMIT 30);
  DELETE FROM chat_turns WHERE at < now() - interval '6 months';
  RETURN jsonb_build_object('ok', true, 'chatKey', k);
END $$;

-- The page: what Nathan remembers about you, and a chat to show again (that chat, or your latest one from the last 12 hours)
CREATE OR REPLACE FUNCTION bgc.memory_page(email text, chat_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH me AS (SELECT bgc.member_id(email) AS id),
  k AS (SELECT coalesce(
    (SELECT t.chat_key FROM chat_turns t, me WHERE t.member_id = me.id AND t.chat_key = memory_page.chat_key LIMIT 1),
    CASE WHEN nullif(memory_page.chat_key, '') IS NULL THEN (SELECT t.chat_key FROM chat_turns t, me WHERE t.member_id = me.id AND t.at > now() - interval '12 hours' ORDER BY t.at DESC LIMIT 1) END) AS key)
  SELECT CASE WHEN me.id IS NULL THEN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only') ELSE jsonb_build_object('ok', true,
    'notes', coalesce((SELECT jsonb_agg(jsonb_build_object('id', n.id, 'note', n.note, 'at', at.iso(n.updated_at)) ORDER BY n.updated_at DESC)
      FROM member_notes n WHERE n.member_id = me.id), '[]'),
    'chats', (SELECT count(DISTINCT t.chat_key) FROM chat_turns t WHERE t.member_id = me.id),
    'chat', CASE WHEN k.key IS NOT NULL THEN jsonb_build_object('key', k.key, 'turns', coalesce((SELECT jsonb_agg(jsonb_build_object('question', x.question, 'answer', x.answer) ORDER BY x.at)
      FROM (SELECT * FROM chat_turns t WHERE t.member_id = me.id AND t.chat_key = k.key ORDER BY t.at DESC LIMIT 20) x), '[]')) END) END
  FROM me, k $$;

-- Forget one note, or (id null) everything: all notes and all conversations
CREATE OR REPLACE FUNCTION bgc.memory_forget(email text, note_id bigint) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email);
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only'); END IF;
  IF note_id IS NULL THEN
    DELETE FROM member_notes WHERE member_id = me;
    DELETE FROM chat_turns WHERE member_id = me;
  ELSE
    DELETE FROM member_notes WHERE member_id = me AND id = note_id;
  END IF;
  RETURN bgc.memory_page(email, NULL);
END $$;

COMMIT;
