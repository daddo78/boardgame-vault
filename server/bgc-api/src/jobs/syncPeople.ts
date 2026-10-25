// Sync People (daily 4:20): from Dan's BGG plays, each person's history per owned game (plays, wins, last) and a player
// card for everyone he has played with; then friends' BGG ratings, stored as stars (BGG's 1-10 halved) apart from ours.
import { atCreate, atList, atPatch } from '../at.js';
import { tallyPeople } from '../bgg.js';
import { listGames, ownerBggUsername } from '../catalog.js';
import { PF, PLAYERS_TABLE, RATINGS_TABLE, RF } from '../fields.js';
import { toGame, toPlayer } from '../shape.gen.js';
import type { Job } from './types.js';

const playerNames = (p: any): string[] => [p.name, ...p.aliases].map((n: string) => n.toLowerCase());

export const syncPeople: Job<{}> = {
  name: 'syncPeople',
  schedule: { at: '04:20' },
  async run({ db, bgg, config }) {
    const username = await ownerBggUsername(db, config);
    if (!username) throw new Error('No BGG username for the owner');
    const people = tallyPeople(await bgg.plays(username));
    const games = (await listGames(db)).map(toGame);
    let players = (await atList(db, PLAYERS_TABLE)).map(toPlayer);

    // A card for everyone Dan has played with (active from 10 plays)
    const known = new Set(players.flatMap(playerNames));
    const now = new Date().toISOString();
    const creates = Object.values(people).filter((p) => p.total >= 1 && !known.has(p.name.toLowerCase()))
      .map((p) => ({ [PF.name]: p.name, [PF.active]: p.total >= 10, [PF.updatedAt]: now }));
    if (creates.length) {
      await atCreate(db, PLAYERS_TABLE, creates);
      await db.one("SELECT at.save_plays($1, '[]'::jsonb)", [config.ownerEmails[0]]); // links the seats to the new cards
      players = (await atList(db, PLAYERS_TABLE)).map(toPlayer);
    }

    // Each card's history per game in the collection (any edition counts toward the game's own BGG id)
    const gameIdByBgg: Record<string, string> = Object.fromEntries(games.filter((g) => g.bggId).map((g) => [String(g.bggId), g.id]));
    const primaryBgg: Record<string, string> = {};
    for (const g of games) if (g.bggId) for (const id of [g.bggId, ...g.extraBggIds]) primaryBgg[String(id)] ??= String(g.bggId);
    const histories: { id: string; fields: Record<string, unknown> }[] = [];
    for (const pl of players) {
      const merged: Record<string, { plays: number; wins: number; last: string | null }> = {};
      for (const n of playerNames(pl)) for (const [bggId, g] of Object.entries((people[n] || { games: {} }).games)) {
        const own = primaryBgg[bggId];
        if (!own) continue;
        const m = (merged[own] ??= { plays: 0, wins: 0, last: null });
        m.plays += g.plays; m.wins += g.wins;
        if (g.last && (!m.last || g.last > m.last)) m.last = g.last;
      }
      if (JSON.stringify(merged) !== JSON.stringify(pl.history)) histories.push({ id: pl.id, fields: { [PF.playHistory]: JSON.stringify(merged), [PF.updatedAt]: now } });
    }
    await atPatch(db, PLAYERS_TABLE, histories);

    // Friends' BGG ratings, for the cards with a BGG username
    const ratings: { fields: Record<string, unknown> }[] = [];
    for (const p of players.filter((x) => x.bggUsername)) {
      const r = await bgg.collectionRatings(p.bggUsername);
      for (const x of r.ratings) {
        const gameId = gameIdByBgg[String(x.bggId)];
        if (!gameId) continue;
        ratings.push({ fields: { [RF.key]: `${p.id}|${gameId}|bgg`, [RF.playerId]: p.id, [RF.gameId]: gameId, [RF.stars]: Math.round(x.rating10) / 2, [RF.source]: 'bgg', [RF.updatedAt]: now } });
      }
    }
    await atPatch(db, RATINGS_TABLE, ratings, RF.key);
    return { people: Object.keys(people).length, players: players.length, playersCreated: creates.length, historiesUpdated: histories.length, bggRatings: ratings.length };
  },
};
