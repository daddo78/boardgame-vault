-- Indexes for the lookups that had none. Every one of these columns is searched on its own somewhere:
--   shelves(game_id)   "who else owns this game" (friends_owning, friends_pool, drop_orphan_game) — the primary key leads with member_id
--   plays(game_id)     drop_orphan_game; plays_game_idx is (owner_id, bgg_id), which doesn't help
--   ratings(game_id)   rating_records_for, drop_orphan_game — the primary key leads with member_id
--   players(legacy_id) every card lookup by its id (apply_player, upsert_rating, delete_rating, shelf_view's asker)
--   players(owner_id, linked_member_id)   "this member's card on that shelf" (shelf_view, sign_in, member_person)
-- Plain indexes, not unique: players.legacy_id is set by every path that makes a card (at.new_key() or the Airtable id) but
-- the column allows NULL and nothing enforces it, and one member can be linked to two cards on the same shelf (the owner's
-- Players screen links by email with no check: at.apply_player). To upgrade legacy_id to unique later, first check
--   SELECT legacy_id, count(*) FROM players GROUP BY 1 HAVING count(*) > 1;
-- Plain CREATE INDEX (not CONCURRENTLY: that can't run in a transaction, and these tables are small).
-- Apply once: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 042_indexes.sql
BEGIN;

CREATE INDEX IF NOT EXISTS shelves_game_idx ON shelves (game_id);
CREATE INDEX IF NOT EXISTS plays_game_id_idx ON plays (game_id);
CREATE INDEX IF NOT EXISTS ratings_game_idx ON ratings (game_id);
CREATE INDEX IF NOT EXISTS players_legacy_idx ON players (legacy_id);
CREATE INDEX IF NOT EXISTS players_linked_idx ON players (owner_id, linked_member_id) WHERE linked_member_id IS NOT NULL;

COMMIT;
