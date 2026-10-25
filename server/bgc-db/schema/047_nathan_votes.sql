-- A thumbs up or down on each of Nathan's replies, with an optional note for Dan. A thumb alone is only counted (by kind
-- of question, never the words); with a note, the member is deliberately sending the question and Nathan's answer to
-- Dan, so Admin → Nathan shows them with the note. Tapping the other thumb changes the vote; the same thumb again clears it.
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 047_nathan_votes.sql  (or bash apply.sh)
BEGIN;

CREATE TABLE IF NOT EXISTS ask_votes (
  id           bigserial PRIMARY KEY,
  member_id    bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  chat_key     text NOT NULL,
  question_key text NOT NULL,                  -- md5 of the question: one vote per reply in a chat
  turn_id      bigint REFERENCES chat_turns(id) ON DELETE SET NULL,
  kind         text NOT NULL DEFAULT 'other',  -- what the answer was about, as ask_log counts it
  vote         text NOT NULL CHECK (vote IN ('up', 'down')),
  note         text NOT NULL DEFAULT '',
  question     text NOT NULL DEFAULT '',       -- kept only with a note
  answer       text NOT NULL DEFAULT '',       -- Nathan's answer in a line (bgc.turn_brief), kept only with a note
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, chat_key, question_key));
CREATE INDEX IF NOT EXISTS ask_votes_at ON ask_votes (created_at DESC);

-- The kind of question an answer was, as afterAnswer logs it: off-topic, else the mode, a person, the intent
CREATE OR REPLACE FUNCTION bgc.answer_kind(a jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN coalesce((a ->> 'offTopic')::boolean, false) THEN 'off-topic'
    ELSE left(coalesce(nullif(a ->> 'mode', ''), CASE WHEN a ? 'person' THEN 'person' END, nullif(a ->> 'intent', ''), 'other'), 20) END $$;

-- A member votes on a reply: { chatKey, question, vote: up | down | '' (clear), note }. Up to 100 a day.
CREATE OR REPLACE FUNCTION bgc.ask_vote(email text, b jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE me bigint := bgc.member_id(email); k text; q text; v text; n text; tid bigint; ta jsonb; cnt int; vid bigint;
BEGIN
  IF me IS NULL THEN RETURN jsonb_build_object('ok', false, 'status', 403, 'message', 'Members only'); END IF;
  k := left(btrim(coalesce(b ->> 'chatKey', '')), 64);
  q := left(btrim(coalesce(b ->> 'question', '')), 500);
  v := b ->> 'vote';
  n := left(btrim(coalesce(b ->> 'note', '')), 1000);
  IF k = '' OR q = '' THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'Which reply was that?'); END IF;
  IF v IS NULL OR v = '' THEN
    DELETE FROM ask_votes WHERE member_id = me AND chat_key = k AND question_key = md5(q);
    RETURN jsonb_build_object('ok', true, 'vote', '');
  END IF;
  IF v NOT IN ('up', 'down') THEN RETURN jsonb_build_object('ok', false, 'status', 400, 'message', 'A thumb up or down, please.'); END IF;
  SELECT count(*) INTO cnt FROM ask_votes WHERE member_id = me AND created_at > now() - interval '1 day';
  IF cnt >= 100 AND NOT EXISTS (SELECT 1 FROM ask_votes WHERE member_id = me AND chat_key = k AND question_key = md5(q)) THEN
    RETURN jsonb_build_object('ok', false, 'status', 429, 'message', 'That''s a lot of thumbs for one day. More tomorrow!');
  END IF;
  -- The saved turn this vote is about (the latest with that question in that chat), for its kind and Nathan's answer
  SELECT id, answer INTO tid, ta FROM chat_turns WHERE member_id = me AND chat_key = k AND left(question, 500) IN (q, q || ' (photo)') ORDER BY at DESC LIMIT 1;
  INSERT INTO ask_votes (member_id, chat_key, question_key, turn_id, kind, vote, note, question, answer)
  VALUES (me, k, md5(q), tid, coalesce(bgc.answer_kind(ta), 'other'), v, n,
    CASE WHEN n <> '' THEN q ELSE '' END, CASE WHEN n <> '' THEN left(coalesce(bgc.turn_brief(ta), ''), 600) ELSE '' END)
  ON CONFLICT (member_id, chat_key, question_key) DO UPDATE SET
    vote = EXCLUDED.vote, updated_at = now(),
    turn_id = coalesce(EXCLUDED.turn_id, ask_votes.turn_id), kind = CASE WHEN EXCLUDED.turn_id IS NOT NULL THEN EXCLUDED.kind ELSE ask_votes.kind END,
    -- A note stays unless a new one replaces it; the question and answer go with the note
    note = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.note ELSE ask_votes.note END,
    question = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.question WHEN ask_votes.note <> '' THEN ask_votes.question ELSE '' END,
    answer = CASE WHEN EXCLUDED.note <> '' THEN EXCLUDED.answer WHEN ask_votes.note <> '' THEN ask_votes.answer ELSE '' END
  RETURNING id INTO vid;
  RETURN jsonb_build_object('ok', true, 'id', vid, 'vote', v, 'note', (SELECT note FROM ask_votes WHERE id = vid));
END $$;

-- Admin → Nathan: the thumbs (7 and 30 days, all time), by kind, and the latest 100 votes; a question and answer only
-- where the member wrote a note
CREATE OR REPLACE FUNCTION bgc.ask_votes_admin(email text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN NOT bgc.is_admin(email) THEN NULL ELSE jsonb_build_object(
    'up7', (SELECT count(*) FROM ask_votes WHERE vote = 'up' AND updated_at > now() - interval '7 days'),
    'down7', (SELECT count(*) FROM ask_votes WHERE vote = 'down' AND updated_at > now() - interval '7 days'),
    'up30', (SELECT count(*) FROM ask_votes WHERE vote = 'up' AND updated_at > now() - interval '30 days'),
    'down30', (SELECT count(*) FROM ask_votes WHERE vote = 'down' AND updated_at > now() - interval '30 days'),
    'upAll', (SELECT count(*) FROM ask_votes WHERE vote = 'up'),
    'downAll', (SELECT count(*) FROM ask_votes WHERE vote = 'down'),
    'notes', (SELECT count(*) FROM ask_votes WHERE note <> ''),
    'byKind', coalesce((SELECT jsonb_object_agg(kind, jsonb_build_object('up', up, 'down', down)) FROM (
      SELECT kind, count(*) FILTER (WHERE vote = 'up') AS up, count(*) FILTER (WHERE vote = 'down') AS down
      FROM ask_votes WHERE updated_at > now() - interval '30 days' GROUP BY kind) k), '{}'),
    'items', coalesce((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('id', v.id, 'vote', v.vote, 'kind', v.kind, 'at', at.iso(v.updated_at),
        'name', m.display_name, 'note', nullif(v.note, ''), 'question', nullif(v.question, ''), 'answer', nullif(v.answer, ''))) ORDER BY v.updated_at DESC)
      FROM (SELECT * FROM ask_votes ORDER BY updated_at DESC LIMIT 100) v LEFT JOIN members m ON m.id = v.member_id), '[]')) END $$;

COMMIT;
