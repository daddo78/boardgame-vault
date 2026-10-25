// Sync Plays (daily 4:00, and "Sync plays now" in the page's settings): Dan's plays from BGG (BG Stats posts them
// there) -> the plays table, and each game's play count and last played on his shelf, other editions counted in.
import { parsePlays, tallyPlays } from '../bgg.js';
import { listGames, ownerBggUsername, patchGames } from '../catalog.js';
import { F } from '../fields.js';
import { toGame } from '../shape.gen.js';
import type { Job } from './types.js';

export const syncPlays: Job<{}> = {
  name: 'syncPlays',
  schedule: { at: '04:00' },
  async run({ db, bgg, config }) {
    const username = await ownerBggUsername(db, config);
    if (!username) throw new Error('No BGG username for the owner (set BGG_USERNAME or the admin\'s BGG username)');
    const pages = await bgg.plays(username);
    const { byGame, total, gamesPlayed } = tallyPlays(pages);
    const parsed = parsePlays(pages);
    if (!parsed.ok) throw new Error('BGG: ' + (parsed.message || 'no plays came back'));
    const stored = await db.one<{ plays: number; newPlays: number }>('SELECT at.save_plays($1, $2::jsonb)', [config.ownerEmails[0], JSON.stringify(parsed.plays)]);
    const games = (await listGames(db)).map(toGame);
    const changes: { id: string; fields: Record<string, unknown> }[] = [];
    let matched = 0;
    for (const g of games) {
      if (!g.bggId) continue;
      const p = { count: 0, last: null as string | null };
      for (const id of [g.bggId, ...g.extraBggIds]) {
        const x = byGame[String(id)];
        if (!x) continue;
        p.count += x.count;
        if (x.last && (!p.last || x.last > p.last)) p.last = x.last;
      }
      if ([g.bggId, ...g.extraBggIds].some((id) => byGame[String(id)])) matched++;
      if ((g.playCount || 0) !== p.count || (g.lastPlayed || null) !== p.last) changes.push({ id: g.recordId, fields: { [F.playCount]: p.count, [F.lastPlayed]: p.last } });
    }
    await patchGames(db, changes);
    return { totalPlays: total, gamesPlayedOnBgg: gamesPlayed, matchedInCollection: matched, updated: changes.length, stored };
  },
};
