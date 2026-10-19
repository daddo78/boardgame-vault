-- Board Game Curator: the database for many shelves and friends (Phase 1).
-- Apply once:  docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 001_init.sql
-- Model: one catalog row per game (BGG facts, shared), one shelf row per person who owns it (everything personal).

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;

-- People who can sign in. Each describes themselves (taste profile); nobody edits someone else's.
CREATE TABLE members (
  id            bigserial PRIMARY KEY,
  google_email  citext UNIQUE NOT NULL,
  display_name  text NOT NULL,
  picture_url   text,
  bgg_username  text,
  is_admin      boolean NOT NULL DEFAULT false,
  friend_code   text UNIQUE NOT NULL DEFAULT upper(substr(md5(random()::text), 1, 6)),
  complexity    smallint CHECK (complexity BETWEEN 1 AND 5),
  conflict      smallint CHECK (conflict BETWEEN 1 AND 5),
  luck          smallint CHECK (luck BETWEEN 1 AND 5),
  table_talk    smallint CHECK (table_talk BETWEEN 1 AND 5),
  theme         smallint CHECK (theme BETWEEN 1 AND 5),
  likes         text NOT NULL DEFAULT '',
  dislikes      text NOT NULL DEFAULT '',
  about         text NOT NULL DEFAULT '',
  age           smallint CHECK (age BETWEEN 1 AND 120),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The shared catalog: facts that are the same for everyone. Games without a BGG match have no bgg_id.
CREATE TABLE games (
  id            bigserial PRIMARY KEY,
  bgg_id        integer UNIQUE,
  title         text NOT NULL,
  year          smallint,
  min_players   smallint,
  max_players   smallint,
  best_players  smallint[] NOT NULL DEFAULT '{}',
  min_time      smallint,
  max_time      smallint,
  min_age       smallint,
  weight        numeric(3,2),
  bgg_rating    numeric(4,2),
  bgg_rank      integer,
  designers     text[] NOT NULL DEFAULT '{}',
  categories    text[] NOT NULL DEFAULT '{}',
  mechanics     text[] NOT NULL DEFAULT '{}',
  genre         text NOT NULL DEFAULT '',   -- curator's short labels and blurb
  type          text NOT NULL DEFAULT '',
  description   text NOT NULL DEFAULT '',
  icon          text NOT NULL DEFAULT 'meeple',
  cover_card    text,
  cover_large   text,
  enriched_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX games_title_idx ON games (lower(title));

-- Who owns what, plus everything personal about their copy.
CREATE TABLE shelves (
  member_id      bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  game_id        bigint NOT NULL REFERENCES games(id),
  num            integer,                        -- the owner's own numbering (#1, #2, ...)
  favorite       boolean NOT NULL DEFAULT false,
  want_to_play   smallint NOT NULL DEFAULT 0 CHECK (want_to_play BETWEEN 0 AND 5),
  thinning       boolean NOT NULL DEFAULT false, -- private to the owner
  expansions     text[] NOT NULL DEFAULT '{}',   -- expansions this person owns
  extra_bgg_ids  integer[] NOT NULL DEFAULT '{}',-- other editions whose plays count toward this copy
  play_count     integer NOT NULL DEFAULT 0,
  last_played    date,
  notes          text NOT NULL DEFAULT '',
  legacy_id      text,                           -- id in the Airtable archive (e.g. manual-g104)
  added_at       timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, game_id)
);
CREATE UNIQUE INDEX shelves_legacy_idx ON shelves (legacy_id) WHERE legacy_id IS NOT NULL;

-- Friend connections: a request by friend code, then accepted. One row per pair.
CREATE TABLE friendships (
  requester_id  bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  addressee_id  bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  PRIMARY KEY (requester_id, addressee_id),
  CHECK (requester_id <> addressee_id)
);
CREATE UNIQUE INDEX friendships_pair_idx ON friendships (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

-- BGC stars: only from the member themselves.
CREATE TABLE ratings (
  member_id   bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  game_id     bigint NOT NULL REFERENCES games(id),
  stars       numeric(2,1) NOT NULL CHECK (stars BETWEEN 0.5 AND 5),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (member_id, game_id)
);

-- BGG ratings, kept apart (out of 10), keyed by BGG username so they attach to whoever has that username.
CREATE TABLE bgg_ratings (
  bgg_username  citext NOT NULL,
  bgg_id        integer NOT NULL,
  rating        numeric(3,1) NOT NULL CHECK (rating BETWEEN 1 AND 10),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bgg_username, bgg_id)
);

-- Each member's own list of the names in their play logs (BG Stats), optionally linked to a member.
CREATE TABLE players (
  id                bigserial PRIMARY KEY,
  owner_id          bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name              text NOT NULL,
  aliases           text[] NOT NULL DEFAULT '{}',
  active            boolean NOT NULL DEFAULT false,
  linked_member_id  bigint REFERENCES members(id) ON DELETE SET NULL,
  bgg_username      text,                         -- for people who never join
  legacy_id         text,                         -- Airtable record id
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- Real play records, synced from each member's BGG account. Games played but not owned still have a catalog row.
CREATE TABLE plays (
  id           bigserial PRIMARY KEY,
  owner_id     bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  bgg_play_id  bigint NOT NULL,
  played_on    date,
  game_id      bigint REFERENCES games(id),
  bgg_id       integer NOT NULL,
  game_name    text NOT NULL DEFAULT '',
  quantity     smallint NOT NULL DEFAULT 1,
  minutes      integer,
  location     text NOT NULL DEFAULT '',
  comments     text NOT NULL DEFAULT '',
  incomplete   boolean NOT NULL DEFAULT false,
  UNIQUE (owner_id, bgg_play_id)
);
CREATE INDEX plays_game_idx ON plays (owner_id, bgg_id);

CREATE TABLE play_players (
  play_id    bigint NOT NULL REFERENCES plays(id) ON DELETE CASCADE,
  seat       smallint NOT NULL,
  player_id  bigint REFERENCES players(id) ON DELETE SET NULL,
  name       text NOT NULL,
  bgg_user   text NOT NULL DEFAULT '',
  win        boolean NOT NULL DEFAULT false,
  score      text NOT NULL DEFAULT '',
  is_new     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (play_id, seat)
);
CREATE INDEX play_players_player_idx ON play_players (player_id);

-- A member's private take on a friend (same card as a profile). Only the writer and Nathan (asked by the writer) read it.
CREATE TABLE friend_takes (
  writer_id    bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  subject_id   bigint NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  complexity   smallint CHECK (complexity BETWEEN 1 AND 5),
  conflict     smallint CHECK (conflict BETWEEN 1 AND 5),
  luck         smallint CHECK (luck BETWEEN 1 AND 5),
  table_talk   smallint CHECK (table_talk BETWEEN 1 AND 5),
  theme        smallint CHECK (theme BETWEEN 1 AND 5),
  likes        text NOT NULL DEFAULT '',
  dislikes     text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (writer_id, subject_id),
  CHECK (writer_id <> subject_id)
);

-- Nathan's daily limit, per member (visitors share one bucket keyed 0)
CREATE TABLE ask_usage (
  member_id  bigint NOT NULL DEFAULT 0,
  day        date NOT NULL,
  questions  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, day)
);

COMMIT;
