-- Airtable-compatible adapter (Phase 1b): lets the existing n8n workflows run on Postgres unchanged.
-- n8n calls at.request(table, method, path, body, formula) where it used to call the Airtable REST API, and gets
-- the same JSON back: { records: [...] } for lists, { id, createdTime, fields } for a single record.
-- Field ids are the old Airtable ones, so the workflows' code is untouched. Everything is scoped to the admin's
-- shelf (the one public collection) until the friends phase replaces this with direct queries.
-- Record builders are VOLATILE on purpose: they must see writes made earlier in the same statement.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 002_airtable_adapter.sql  (safe to re-run)

BEGIN;
CREATE SCHEMA IF NOT EXISTS at;

CREATE OR REPLACE FUNCTION at.admin_id() RETURNS bigint LANGUAGE sql STABLE AS
$$ SELECT id FROM members WHERE is_admin ORDER BY id LIMIT 1 $$;

-- New record ids look like Airtable's (rec + 14 characters), so existing validation keeps working
CREATE OR REPLACE FUNCTION at.new_key() RETURNS text LANGUAGE sql VOLATILE AS $$
  SELECT 'rec' || string_agg(substr('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 1 + floor(random() * 62)::int, 1), '')
  FROM generate_series(1, 14) $$;

CREATE OR REPLACE FUNCTION at.iso(t timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- Airtable-style values in: numbers may arrive as strings, lists as JSON text or arrays
CREATE OR REPLACE FUNCTION at.num(v jsonb) RETURNS numeric LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN v IS NULL OR jsonb_typeof(v) = 'null' THEN NULL ELSE nullif(trim(v #>> '{}'), '')::numeric END $$;
CREATE OR REPLACE FUNCTION at.txt(v jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN v IS NULL OR jsonb_typeof(v) = 'null' THEN NULL WHEN jsonb_typeof(v) = 'object' THEN v ->> 'name' ELSE v #>> '{}' END $$;
CREATE OR REPLACE FUNCTION at.bool(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS
$$ SELECT coalesce(lower(v #>> '{}') IN ('true', '1'), false) $$;
CREATE OR REPLACE FUNCTION at.arr(v jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL OR jsonb_typeof(v) = 'null' THEN '{}'::text[]
    WHEN jsonb_typeof(v) = 'array' THEN ARRAY(SELECT jsonb_array_elements_text(v))
    WHEN left(ltrim(v #>> '{}'), 1) = '[' THEN ARRAY(SELECT jsonb_array_elements_text((v #>> '{}')::jsonb))
    WHEN trim(v #>> '{}') = '' THEN '{}'::text[]
    ELSE ARRAY(SELECT trim(x) FROM unnest(string_to_array(v #>> '{}', ',')) x WHERE trim(x) <> '') END $$;

-- ---------- Games (Dan's shelf joined to the catalog) ----------
CREATE OR REPLACE FUNCTION at.game_record(s shelves) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('id', s.legacy_id, 'createdTime', at.iso(s.added_at), 'fields', jsonb_strip_nulls(
    jsonb_build_object(
      'fldOSxvCDWJdYbUZe', g.title, 'fldJ1g6gtxWDwlWsI', s.legacy_id, 'fldMTwTBzGdIl5juS', s.num,
      'fldiVlY0CFWH4HMmy', nullif(g.genre, ''), 'fldAz2n321hbVgQyN', nullif(g.type, ''), 'fldUvT2Ek81fKIIDG', nullif(g.description, ''),
      'fldVITaI4eagPe9tS', to_jsonb(s.expansions)::text, 'fldV5vlwouSyJcPjY', s.want_to_play, 'fldskzh1rq9uchgYI', s.thinning,
      'fldAeaCX58kL3EtaF', g.icon, 'fldbWi7hhf2VGYzZl', g.bgg_id, 'fld39CpmejKlyRSU9', g.bgg_rating,
      'fldH3CEdj0SibBeMJ', at.iso(s.added_at), 'fldFQIX0PXXyas2V7', at.iso(s.updated_at))
    || jsonb_build_object(
      'fldzXSHLRYoKjn9YY', g.min_players, 'fldwlQj31eoBIgF32', g.max_players, 'fldGj8TR8Qgr3awAe', to_jsonb(g.best_players)::text,
      'fldmxVhDKLpxevVS4', g.min_time, 'fldAAPDFVAH2lOax5', g.max_time, 'flduy1oWFgwMcu3my', g.weight,
      'fldt0ihrGswaVysGs', g.year, 'fldyGkN5wNmeMWY1Z', g.min_age, 'fldv2Eza3ozH8eFTy', to_jsonb(g.designers)::text,
      'fldydnO9FCaM9K4Bx', g.bgg_rank, 'fldDiWapezN3rdwyH', to_jsonb(g.categories)::text, 'fldBe9528dZEr70ez', to_jsonb(g.mechanics)::text,
      'fld9pSGve6FsTDxMN', s.play_count, 'fldVjyyNET9JmjN8d', s.last_played, 'fldyfp0FG1zY0K4qu', s.favorite,
      'fldzltyZj2UE9Mj67', nullif(array_to_string(s.extra_bgg_ids, ','), ''),
      'fldjYYhunnxlv1OI3', g.cover_card, 'flduJBzJRHtHfFR44', g.cover_large)))
  FROM games g WHERE g.id = s.game_id $$;

-- A catalog row nobody owns, plays or rates (e.g. a photo add that turned out to be a duplicate) is removed
CREATE OR REPLACE FUNCTION at.drop_orphan_game(gid bigint) RETURNS void LANGUAGE sql AS $$
  DELETE FROM games g WHERE g.id = gid AND g.bgg_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM shelves WHERE game_id = gid) AND NOT EXISTS (SELECT 1 FROM plays WHERE game_id = gid)
    AND NOT EXISTS (SELECT 1 FROM ratings WHERE game_id = gid) $$;

CREATE OR REPLACE FUNCTION at.apply_game(skey text, f jsonb) RETURNS shelves LANGUAGE plpgsql AS $$
DECLARE
  s shelves; gid bigint; new_bgg integer; cur_bgg integer; v_other bigint;
BEGIN
  SELECT * INTO s FROM shelves WHERE member_id = at.admin_id() AND legacy_id = skey;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: game %', skey; END IF;
  gid := s.game_id;

  -- Linking to a BGG game: never rewrite a catalog row that already has a BGG id (its plays point at it)
  IF f ? 'fldbWi7hhf2VGYzZl' THEN
    new_bgg := at.num(f -> 'fldbWi7hhf2VGYzZl')::integer;
    SELECT bgg_id INTO cur_bgg FROM games WHERE id = gid;
    IF new_bgg IS NOT NULL AND new_bgg IS DISTINCT FROM cur_bgg THEN
      SELECT id INTO v_other FROM games WHERE bgg_id = new_bgg;
      IF v_other IS NULL THEN
        IF cur_bgg IS NULL THEN
          UPDATE games SET bgg_id = new_bgg WHERE id = gid;
        ELSE
          INSERT INTO games (bgg_id, title) SELECT new_bgg, title FROM games WHERE id = gid RETURNING id INTO v_other;
          UPDATE shelves SET game_id = v_other WHERE member_id = s.member_id AND game_id = gid;
          gid := v_other;
        END IF;
      ELSIF NOT EXISTS (SELECT 1 FROM shelves WHERE member_id = s.member_id AND game_id = v_other) THEN
        UPDATE shelves SET game_id = v_other WHERE member_id = s.member_id AND game_id = gid;
        PERFORM at.drop_orphan_game(gid);
        gid := v_other;
      END IF;
      -- else: the shelf already has that game (a duplicate photo add); leave this row unlinked so it can be removed
    END IF;
  END IF;

  UPDATE games SET
    title       = CASE WHEN f ? 'fldOSxvCDWJdYbUZe' AND coalesce(at.txt(f -> 'fldOSxvCDWJdYbUZe'), '') <> '' THEN at.txt(f -> 'fldOSxvCDWJdYbUZe') ELSE title END,
    genre       = CASE WHEN f ? 'fldiVlY0CFWH4HMmy' THEN coalesce(at.txt(f -> 'fldiVlY0CFWH4HMmy'), '') ELSE genre END,
    type        = CASE WHEN f ? 'fldAz2n321hbVgQyN' THEN coalesce(at.txt(f -> 'fldAz2n321hbVgQyN'), '') ELSE type END,
    description = CASE WHEN f ? 'fldUvT2Ek81fKIIDG' THEN coalesce(at.txt(f -> 'fldUvT2Ek81fKIIDG'), '') ELSE description END,
    icon        = CASE WHEN f ? 'fldAeaCX58kL3EtaF' THEN coalesce(nullif(at.txt(f -> 'fldAeaCX58kL3EtaF'), ''), 'meeple') ELSE icon END,
    bgg_rating  = CASE WHEN f ? 'fld39CpmejKlyRSU9' THEN at.num(f -> 'fld39CpmejKlyRSU9') ELSE bgg_rating END,
    min_players = CASE WHEN f ? 'fldzXSHLRYoKjn9YY' THEN at.num(f -> 'fldzXSHLRYoKjn9YY') ELSE min_players END,
    max_players = CASE WHEN f ? 'fldwlQj31eoBIgF32' THEN at.num(f -> 'fldwlQj31eoBIgF32') ELSE max_players END,
    best_players= CASE WHEN f ? 'fldGj8TR8Qgr3awAe' THEN at.arr(f -> 'fldGj8TR8Qgr3awAe')::smallint[] ELSE best_players END,
    min_time    = CASE WHEN f ? 'fldmxVhDKLpxevVS4' THEN at.num(f -> 'fldmxVhDKLpxevVS4') ELSE min_time END,
    max_time    = CASE WHEN f ? 'fldAAPDFVAH2lOax5' THEN at.num(f -> 'fldAAPDFVAH2lOax5') ELSE max_time END,
    weight      = CASE WHEN f ? 'flduy1oWFgwMcu3my' THEN at.num(f -> 'flduy1oWFgwMcu3my') ELSE weight END,
    year        = CASE WHEN f ? 'fldt0ihrGswaVysGs' THEN at.num(f -> 'fldt0ihrGswaVysGs') ELSE year END,
    min_age     = CASE WHEN f ? 'fldyGkN5wNmeMWY1Z' THEN at.num(f -> 'fldyGkN5wNmeMWY1Z') ELSE min_age END,
    designers   = CASE WHEN f ? 'fldv2Eza3ozH8eFTy' THEN at.arr(f -> 'fldv2Eza3ozH8eFTy') ELSE designers END,
    bgg_rank    = CASE WHEN f ? 'fldydnO9FCaM9K4Bx' THEN at.num(f -> 'fldydnO9FCaM9K4Bx') ELSE bgg_rank END,
    categories  = CASE WHEN f ? 'fldDiWapezN3rdwyH' THEN at.arr(f -> 'fldDiWapezN3rdwyH') ELSE categories END,
    mechanics   = CASE WHEN f ? 'fldBe9528dZEr70ez' THEN at.arr(f -> 'fldBe9528dZEr70ez') ELSE mechanics END,
    cover_card  = CASE WHEN f ? 'fldjYYhunnxlv1OI3' THEN nullif(at.txt(f -> 'fldjYYhunnxlv1OI3'), '') ELSE cover_card END,
    cover_large = CASE WHEN f ? 'flduJBzJRHtHfFR44' THEN nullif(at.txt(f -> 'flduJBzJRHtHfFR44'), '') ELSE cover_large END,
    enriched_at = CASE WHEN f ? 'fldBe9528dZEr70ez' OR f ? 'fldjYYhunnxlv1OI3' THEN now() ELSE enriched_at END,
    updated_at  = now()
  WHERE id = gid;

  UPDATE shelves SET
    num           = CASE WHEN f ? 'fldMTwTBzGdIl5juS' THEN at.num(f -> 'fldMTwTBzGdIl5juS') ELSE num END,
    expansions    = CASE WHEN f ? 'fldVITaI4eagPe9tS' THEN at.arr(f -> 'fldVITaI4eagPe9tS') ELSE expansions END,
    want_to_play  = CASE WHEN f ? 'fldV5vlwouSyJcPjY' THEN coalesce(at.num(f -> 'fldV5vlwouSyJcPjY'), 0) ELSE want_to_play END,
    thinning      = CASE WHEN f ? 'fldskzh1rq9uchgYI' THEN at.bool(f -> 'fldskzh1rq9uchgYI') ELSE thinning END,
    favorite      = CASE WHEN f ? 'fldyfp0FG1zY0K4qu' THEN at.bool(f -> 'fldyfp0FG1zY0K4qu') ELSE favorite END,
    play_count    = CASE WHEN f ? 'fld9pSGve6FsTDxMN' THEN coalesce(at.num(f -> 'fld9pSGve6FsTDxMN'), 0) ELSE play_count END,
    last_played   = CASE WHEN f ? 'fldVjyyNET9JmjN8d' THEN nullif(at.txt(f -> 'fldVjyyNET9JmjN8d'), '')::date ELSE last_played END,
    extra_bgg_ids = CASE WHEN f ? 'fldzltyZj2UE9Mj67' THEN at.arr(f -> 'fldzltyZj2UE9Mj67')::integer[] ELSE extra_bgg_ids END,
    added_at      = CASE WHEN f ? 'fldH3CEdj0SibBeMJ' AND at.txt(f -> 'fldH3CEdj0SibBeMJ') IS NOT NULL THEN at.txt(f -> 'fldH3CEdj0SibBeMJ')::timestamptz ELSE added_at END,
    updated_at    = now()
  WHERE member_id = s.member_id AND legacy_id = skey
  RETURNING * INTO s;
  RETURN s;
END $$;

CREATE OR REPLACE FUNCTION at.create_game(f jsonb) RETURNS shelves LANGUAGE plpgsql AS $$
DECLARE
  gid bigint; skey text := coalesce(nullif(at.txt(f -> 'fldJ1g6gtxWDwlWsI'), ''), at.new_key()); bgg integer := at.num(f -> 'fldbWi7hhf2VGYzZl')::integer;
BEGIN
  IF bgg IS NOT NULL THEN SELECT id INTO gid FROM games WHERE bgg_id = bgg; END IF;
  IF gid IS NOT NULL AND EXISTS (SELECT 1 FROM shelves WHERE member_id = at.admin_id() AND game_id = gid) THEN gid := NULL; bgg := NULL; END IF;
  IF gid IS NULL THEN
    INSERT INTO games (title) VALUES (coalesce(nullif(at.txt(f -> 'fldOSxvCDWJdYbUZe'), ''), 'Untitled')) RETURNING id INTO gid;
  END IF;
  INSERT INTO shelves (member_id, game_id, legacy_id) VALUES (at.admin_id(), gid, skey);
  RETURN at.apply_game(skey, f - 'fldJ1g6gtxWDwlWsI' - CASE WHEN bgg IS NULL THEN 'fldbWi7hhf2VGYzZl' ELSE '' END);
END $$;

CREATE OR REPLACE FUNCTION at.delete_game(skey text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE gid bigint;
BEGIN
  DELETE FROM shelves WHERE member_id = at.admin_id() AND legacy_id = skey RETURNING game_id INTO gid;
  IF gid IS NOT NULL THEN PERFORM at.drop_orphan_game(gid); END IF;
END $$;

-- ---------- Players (the admin's BG Stats names; profiles come from the linked member) ----------
CREATE OR REPLACE FUNCTION at.player_history(pid bigint) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT coalesce(jsonb_object_agg(own_bgg::text, jsonb_build_object('plays', plays, 'wins', wins, 'last', last)), '{}'::jsonb)
  FROM (
    SELECT g.bgg_id AS own_bgg, sum(p.quantity)::int AS plays, coalesce(sum(p.quantity) FILTER (WHERE pp.win), 0)::int AS wins, max(p.played_on) AS last
    FROM play_players pp
    JOIN plays p ON p.id = pp.play_id
    JOIN players pl ON pl.id = pp.player_id
    JOIN shelves s ON s.member_id = pl.owner_id
    JOIN games g ON g.id = s.game_id AND g.bgg_id IS NOT NULL AND (g.bgg_id = p.bgg_id OR p.bgg_id = ANY (s.extra_bgg_ids))
    WHERE pp.player_id = pid
    GROUP BY g.bgg_id) h $$;

CREATE OR REPLACE FUNCTION at.player_record(p players) RETURNS jsonb LANGUAGE sql VOLATILE AS $$
  SELECT jsonb_build_object('id', p.legacy_id, 'createdTime', at.iso(p.created_at), 'fields', jsonb_strip_nulls(jsonb_build_object(
    'fldWVws64FVcdtuSJ', p.name, 'fldbPxy87tXFVHtm1', nullif(array_to_string(p.aliases, ', '), ''), 'fldCTgjMOoTTokadR', p.active,
    'fldnwPL9Z33JcXoj2', m.google_email::text, 'fldDfHIAzk1AyaJEd', coalesce(nullif(p.bgg_username, ''), m.bgg_username),
    'fldobSISLYhxr2nb5', m.complexity, 'fldslaw9Fv5cxiICf', m.conflict, 'fldzLybJ5l8ALWyPz', m.luck,
    'fldVkKcUgFxkxTNfi', m.table_talk, 'fldk6X4H1FHJ7Uugm', m.theme,
    'fld7R2WFALqZ2gkR7', nullif(m.likes, ''), 'fld6ynTKz3kfM6QHx', nullif(m.dislikes, ''), 'fldZvY4FJ2QQDCyyh', m.age,
    'fldcgwd6wvrgnTSdW', nullif(m.about, ''), 'fldGI1Kr6p107QdZp', at.player_history(p.id)::text,
    'fldyIFTgzcvEqKaGK', at.iso(greatest(p.updated_at, coalesce(m.updated_at, p.updated_at))))))
  FROM (SELECT 1) one LEFT JOIN members m ON m.id = p.linked_member_id $$;

CREATE OR REPLACE FUNCTION at.apply_player(pkey text, f jsonb) RETURNS players LANGUAGE plpgsql AS $$
DECLARE p players; mid bigint; email text; dial_cols text[] := ARRAY['complexity', 'conflict', 'luck', 'table_talk', 'theme'];
BEGIN
  SELECT * INTO p FROM players WHERE owner_id = at.admin_id() AND legacy_id = pkey;
  IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: player %', pkey; END IF;
  UPDATE players SET
    name         = CASE WHEN f ? 'fldWVws64FVcdtuSJ' AND coalesce(at.txt(f -> 'fldWVws64FVcdtuSJ'), '') <> '' THEN at.txt(f -> 'fldWVws64FVcdtuSJ') ELSE name END,
    aliases      = CASE WHEN f ? 'fldbPxy87tXFVHtm1' THEN at.arr(f -> 'fldbPxy87tXFVHtm1') ELSE aliases END,
    active       = CASE WHEN f ? 'fldCTgjMOoTTokadR' THEN at.bool(f -> 'fldCTgjMOoTTokadR') ELSE active END,
    bgg_username = CASE WHEN f ? 'fldDfHIAzk1AyaJEd' THEN nullif(at.txt(f -> 'fldDfHIAzk1AyaJEd'), '') ELSE bgg_username END,
    updated_at   = now()
  WHERE id = p.id RETURNING * INTO p;

  -- A Google email makes (or finds) a member and links this player to them; clearing it unlinks (the member stays)
  IF f ? 'fldnwPL9Z33JcXoj2' THEN
    email := lower(nullif(trim(coalesce(at.txt(f -> 'fldnwPL9Z33JcXoj2'), '')), ''));
    IF email IS NULL THEN
      IF NOT EXISTS (SELECT 1 FROM members WHERE id = p.linked_member_id AND is_admin) THEN UPDATE players SET linked_member_id = NULL WHERE id = p.id; END IF;
    ELSE
      INSERT INTO members (google_email, display_name) VALUES (email, p.name) ON CONFLICT (google_email) DO NOTHING;
      SELECT id INTO mid FROM members WHERE google_email = email;
      UPDATE players SET linked_member_id = mid WHERE id = p.id;
    END IF;
  END IF;

  -- The taste profile belongs to the linked member (only /me sends these)
  SELECT linked_member_id INTO mid FROM players WHERE id = p.id;
  IF mid IS NOT NULL THEN
    UPDATE members SET
      complexity = CASE WHEN f ? 'fldobSISLYhxr2nb5' THEN at.num(f -> 'fldobSISLYhxr2nb5') ELSE complexity END,
      conflict   = CASE WHEN f ? 'fldslaw9Fv5cxiICf' THEN at.num(f -> 'fldslaw9Fv5cxiICf') ELSE conflict END,
      luck       = CASE WHEN f ? 'fldzLybJ5l8ALWyPz' THEN at.num(f -> 'fldzLybJ5l8ALWyPz') ELSE luck END,
      table_talk = CASE WHEN f ? 'fldVkKcUgFxkxTNfi' THEN at.num(f -> 'fldVkKcUgFxkxTNfi') ELSE table_talk END,
      theme      = CASE WHEN f ? 'fldk6X4H1FHJ7Uugm' THEN at.num(f -> 'fldk6X4H1FHJ7Uugm') ELSE theme END,
      likes      = CASE WHEN f ? 'fld7R2WFALqZ2gkR7' THEN coalesce(at.txt(f -> 'fld7R2WFALqZ2gkR7'), '') ELSE likes END,
      dislikes   = CASE WHEN f ? 'fld6ynTKz3kfM6QHx' THEN coalesce(at.txt(f -> 'fld6ynTKz3kfM6QHx'), '') ELSE dislikes END,
      about      = CASE WHEN f ? 'fldcgwd6wvrgnTSdW' THEN coalesce(at.txt(f -> 'fldcgwd6wvrgnTSdW'), '') ELSE about END,
      age        = CASE WHEN f ? 'fldZvY4FJ2QQDCyyh' THEN at.num(f -> 'fldZvY4FJ2QQDCyyh') ELSE age END,
      bgg_username = CASE WHEN f ? 'fldDfHIAzk1AyaJEd' AND NOT (f ? 'fldCTgjMOoTTokadR') THEN nullif(at.txt(f -> 'fldDfHIAzk1AyaJEd'), '') ELSE bgg_username END,
      updated_at = now()
    WHERE id = mid AND (f ?| ARRAY['fldobSISLYhxr2nb5', 'fldslaw9Fv5cxiICf', 'fldzLybJ5l8ALWyPz', 'fldVkKcUgFxkxTNfi', 'fldk6X4H1FHJ7Uugm',
                                  'fld7R2WFALqZ2gkR7', 'fld6ynTKz3kfM6QHx', 'fldcgwd6wvrgnTSdW', 'fldZvY4FJ2QQDCyyh']);
  END IF;
  -- playHistory is derived from the plays tables, so writes to it are ignored
  SELECT * INTO p FROM players WHERE id = p.id;
  RETURN p;
END $$;

CREATE OR REPLACE FUNCTION at.create_player(f jsonb) RETURNS players LANGUAGE plpgsql AS $$
DECLARE pkey text := at.new_key(); nm text := coalesce(nullif(at.txt(f -> 'fldWVws64FVcdtuSJ'), ''), 'Player');
BEGIN
  INSERT INTO players (owner_id, name, legacy_id) VALUES (at.admin_id(), nm, pkey)
    ON CONFLICT (owner_id, name) DO UPDATE SET updated_at = now() RETURNING legacy_id INTO pkey;
  RETURN at.apply_player(pkey, f);
END $$;

-- ---------- Ratings: BGC stars (members) and BGG ratings (by BGG username), keyed like the old Ratings table ----------
CREATE OR REPLACE FUNCTION at.rating_records() RETURNS SETOF jsonb LANGUAGE sql VOLATILE AS $$
  WITH me AS (SELECT at.admin_id() AS id)
  SELECT jsonb_build_object('id', k, 'createdTime', at.iso(t), 'fields', jsonb_build_object(
      'fldSVVMwQygNrpyBm', k, 'fldB2cw5ie4ypHPGl', pkey, 'fldhrJoBfiLAg1E8q', skey, 'fldSM283jOPAOs2YP', stars,
      'fldaPLq2gL3UP6zon', src, 'fldqI4c09b3iHt3um', at.iso(t)))
  FROM (
    SELECT pl.legacy_id || '|' || s.legacy_id || '|site' AS k, pl.legacy_id AS pkey, s.legacy_id AS skey, r.stars, 'site' AS src, r.updated_at AS t
    FROM ratings r, me
    JOIN players pl ON pl.owner_id = me.id
    JOIN shelves s ON s.member_id = me.id
    WHERE pl.linked_member_id = r.member_id AND s.game_id = r.game_id
    UNION ALL
    SELECT pl.legacy_id || '|' || s.legacy_id || '|bgg', pl.legacy_id, s.legacy_id, round(b.rating) / 2, 'bgg', b.fetched_at
    FROM bgg_ratings b, me
    JOIN players pl ON pl.owner_id = me.id
    LEFT JOIN members m ON m.id = pl.linked_member_id
    JOIN games g ON true
    JOIN shelves s ON s.member_id = me.id AND s.game_id = g.id
    WHERE g.bgg_id = b.bgg_id AND lower(coalesce(nullif(pl.bgg_username, ''), m.bgg_username)) = lower(b.bgg_username::text)
  ) x $$;

CREATE OR REPLACE FUNCTION at.upsert_rating(f jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE src text := at.txt(f -> 'fldaPLq2gL3UP6zon'); pkey text := at.txt(f -> 'fldB2cw5ie4ypHPGl'); skey text := at.txt(f -> 'fldhrJoBfiLAg1E8q');
  stars numeric := at.num(f -> 'fldSM283jOPAOs2YP'); mid bigint; gid bigint; uname text; bgg integer;
BEGIN
  SELECT pl.linked_member_id, coalesce(nullif(pl.bgg_username, ''), m.bgg_username) INTO mid, uname
    FROM players pl LEFT JOIN members m ON m.id = pl.linked_member_id WHERE pl.owner_id = at.admin_id() AND pl.legacy_id = pkey;
  SELECT s.game_id, g.bgg_id INTO gid, bgg FROM shelves s JOIN games g ON g.id = s.game_id WHERE s.member_id = at.admin_id() AND s.legacy_id = skey;
  IF gid IS NULL THEN RETURN NULL; END IF;
  IF src = 'site' AND mid IS NOT NULL THEN
    INSERT INTO ratings (member_id, game_id, stars) VALUES (mid, gid, stars)
      ON CONFLICT (member_id, game_id) DO UPDATE SET stars = EXCLUDED.stars, updated_at = now();
  ELSIF src = 'bgg' AND uname IS NOT NULL AND bgg IS NOT NULL THEN
    INSERT INTO bgg_ratings (bgg_username, bgg_id, rating) VALUES (uname, bgg, least(10, greatest(1, stars * 2)))
      ON CONFLICT (bgg_username, bgg_id) DO UPDATE SET rating = EXCLUDED.rating, fetched_at = now();
  ELSE
    RETURN NULL; -- other sources (BG Stats play ratings) are not someone's own rating
  END IF;
  RETURN (SELECT r FROM at.rating_records() r WHERE r ->> 'id' = pkey || '|' || skey || '|' || src);
END $$;

CREATE OR REPLACE FUNCTION at.delete_rating(rkey text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE parts text[] := string_to_array(rkey, '|');
BEGIN
  IF parts[3] = 'site' THEN
    DELETE FROM ratings r USING players pl, shelves s
    WHERE pl.owner_id = at.admin_id() AND pl.legacy_id = parts[1] AND r.member_id = pl.linked_member_id
      AND s.member_id = at.admin_id() AND s.legacy_id = parts[2] AND r.game_id = s.game_id;
  END IF;
END $$;

-- ---------- The request dispatcher n8n calls ----------
CREATE OR REPLACE FUNCTION at.request(tbl text, method text, path text, body jsonb, formula text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  kind text := CASE tbl WHEN 'tblbGc0UuDxIPP2a8' THEN 'games' WHEN 'tblNahVdHDueJJ0w4' THEN 'players' WHEN 'tbllInOWIokikEiQH' THEN 'ratings' ELSE tbl END;
  one text := nullif(substring(coalesce(path, '') FROM '^/([^/?]+)'), '');
  m text[]; fkind text; fval text; recs jsonb := '[]'::jsonb; r jsonb; out jsonb; ids text[];
BEGIN
  method := upper(method);
  IF method = 'GET' THEN
    IF kind = 'games' THEN
      SELECT coalesce(jsonb_agg(at.game_record(s) ORDER BY s.num NULLS LAST, s.legacy_id), '[]') INTO recs FROM shelves s WHERE s.member_id = at.admin_id();
    ELSIF kind = 'players' THEN
      SELECT coalesce(jsonb_agg(at.player_record(p) ORDER BY p.name), '[]') INTO recs FROM players p WHERE p.owner_id = at.admin_id();
    ELSIF kind = 'ratings' THEN
      SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM at.rating_records() x;
    ELSE RAISE EXCEPTION 'unknown table %', tbl; END IF;
    IF one IS NOT NULL THEN
      SELECT x INTO out FROM jsonb_array_elements(recs) x WHERE x ->> 'id' = one;
      IF out IS NULL THEN RAISE EXCEPTION 'NOT_FOUND: % %', kind, one; END IF;
      RETURN out;
    END IF;
    IF coalesce(formula, '') <> '' THEN
      m := regexp_match(formula, '^\s*(RECORD_ID\(\)|\{GameID\}|\{Key\}|LOWER\(\{GoogleEmail\}\))\s*=\s*''(.*)''\s*$');
      IF m IS NULL THEN RAISE EXCEPTION 'unsupported formula: %', formula; END IF;
      fkind := m[1]; fval := replace(m[2], '\''', '''');
      IF fkind = 'LOWER({GoogleEmail})' AND kind = 'players' THEN
        -- A member signing in: their player in the admin's list; a member without one gets one
        IF EXISTS (SELECT 1 FROM members WHERE google_email = fval)
           AND NOT EXISTS (SELECT 1 FROM players pl JOIN members mm ON mm.id = pl.linked_member_id WHERE pl.owner_id = at.admin_id() AND mm.google_email = fval) THEN
          INSERT INTO players (owner_id, name, linked_member_id, legacy_id)
            SELECT at.admin_id(), mm.display_name, mm.id, at.new_key() FROM members mm WHERE mm.google_email = fval
            ON CONFLICT (owner_id, name) DO UPDATE SET linked_member_id = EXCLUDED.linked_member_id;
          SELECT coalesce(jsonb_agg(at.player_record(p)), '[]') INTO recs FROM players p WHERE p.owner_id = at.admin_id();
        END IF;
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE lower(x -> 'fields' ->> 'fldnwPL9Z33JcXoj2') = lower(fval);
      ELSIF fkind = '{GameID}' THEN
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE x -> 'fields' ->> 'fldJ1g6gtxWDwlWsI' = fval;
      ELSIF fkind = '{Key}' THEN
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE x -> 'fields' ->> 'fldSVVMwQygNrpyBm' = fval;
      ELSE
        SELECT coalesce(jsonb_agg(x), '[]') INTO recs FROM jsonb_array_elements(recs) x WHERE x ->> 'id' = fval;
      END IF;
    END IF;
    RETURN jsonb_build_object('records', recs);

  ELSIF method = 'PATCH' THEN
    IF one IS NOT NULL THEN
      IF kind = 'games' THEN RETURN at.game_record(at.apply_game(one, body -> 'fields'));
      ELSIF kind = 'players' THEN RETURN at.player_record(at.apply_player(one, body -> 'fields'));
      ELSE RAISE EXCEPTION 'unsupported PATCH %', kind; END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(coalesce(body -> 'records', '[]')) LOOP
      IF kind = 'games' THEN recs := recs || jsonb_build_array(at.game_record(at.apply_game(r ->> 'id', r -> 'fields')));
      ELSIF kind = 'players' THEN recs := recs || jsonb_build_array(at.player_record(at.apply_player(r ->> 'id', r -> 'fields')));
      ELSIF kind = 'ratings' THEN out := at.upsert_rating(r -> 'fields'); IF out IS NOT NULL THEN recs := recs || jsonb_build_array(out); END IF;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('records', recs);

  ELSIF method = 'POST' THEN
    IF body ? 'fields' AND NOT (body ? 'records') THEN
      IF kind = 'games' THEN RETURN at.game_record(at.create_game(body -> 'fields'));
      ELSIF kind = 'players' THEN RETURN at.player_record(at.create_player(body -> 'fields'));
      ELSE RAISE EXCEPTION 'unsupported POST %', kind; END IF;
    END IF;
    FOR r IN SELECT * FROM jsonb_array_elements(coalesce(body -> 'records', '[]')) LOOP
      IF kind = 'games' THEN recs := recs || jsonb_build_array(at.game_record(at.create_game(r -> 'fields')));
      ELSIF kind = 'players' THEN recs := recs || jsonb_build_array(at.player_record(at.create_player(r -> 'fields')));
      ELSIF kind = 'ratings' THEN out := at.upsert_rating(r -> 'fields'); IF out IS NOT NULL THEN recs := recs || jsonb_build_array(out); END IF;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('records', recs);

  ELSIF method = 'DELETE' THEN
    ids := CASE WHEN one IS NOT NULL THEN ARRAY[one]
      ELSE ARRAY(SELECT (regexp_matches(coalesce(path, ''), 'records\[\]=([^&]+)', 'g'))[1]) END;
    FOR i IN 1 .. coalesce(array_length(ids, 1), 0) LOOP
      IF kind = 'games' THEN PERFORM at.delete_game(ids[i]);
      ELSIF kind = 'ratings' THEN PERFORM at.delete_rating(ids[i]);
      ELSE RAISE EXCEPTION 'unsupported DELETE %', kind; END IF;
      recs := recs || jsonb_build_array(jsonb_build_object('id', ids[i], 'deleted', true));
    END LOOP;
    IF one IS NOT NULL THEN RETURN jsonb_build_object('id', one, 'deleted', true); END IF;
    RETURN jsonb_build_object('records', recs);
  END IF;
  RAISE EXCEPTION 'unsupported method %', method;
END $$;

-- ---------- Plays: the daily sync stores every play (games played but not owned get a bare catalog row) ----------
-- plays: [{ id, date, quantity, minutes, incomplete, location, bggId, gameName, comments, players: [{ seat, name, user, win, score, isNew }] }]
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
    INSERT INTO play_players (play_id, seat, player_id, name, bgg_user, win, score, is_new)
    SELECT v_play, (x ->> 'seat')::smallint,
      (SELECT pl.id FROM players pl WHERE pl.owner_id = oid AND (lower(pl.name) = lower(x ->> 'name') OR lower(x ->> 'name') = ANY (SELECT lower(a) FROM unnest(pl.aliases) a)) LIMIT 1),
      coalesce(x ->> 'name', ''), coalesce(x ->> 'user', ''), coalesce((x ->> 'win')::boolean, false), coalesce(x ->> 'score', ''), coalesce((x ->> 'isNew')::boolean, false)
    FROM jsonb_array_elements(p -> 'players') x;
  END LOOP;
  -- Seats whose name now matches a player (e.g. a player card added since) get linked
  UPDATE play_players pp SET player_id = pl.id
  FROM plays pg, players pl
  WHERE pp.play_id = pg.id AND pg.owner_id = oid AND pp.player_id IS NULL AND pl.owner_id = oid
    AND (lower(pl.name) = lower(pp.name) OR lower(pp.name) = ANY (SELECT lower(a) FROM unnest(pl.aliases) a));
  RETURN jsonb_build_object('plays', n_all, 'newPlays', n_new);
END $$;

COMMIT;
