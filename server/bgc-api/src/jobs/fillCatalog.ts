// Fill Catalog (every 10 minutes): 20 catalog games that were never looked up on BGG (they came in from logged plays)
// get their details and box art. Wishlist and Top 10 games first, then games on shelves (bgc.catalog_to_fill decides).
import type { Job } from './types.js';

export const fillCatalog: Job<{}> = {
  name: 'fillCatalog',
  schedule: { everyMinutes: 10 },
  async run({ db, bgg }) {
    const ids = await db.one<string>('SELECT bgc.catalog_to_fill(20)', []);
    if (!ids) return { asked: 0, found: 0 };
    const things = [];
    for (const t of await bgg.things(ids.split(','))) things.push(await bgg.withCover(t));
    if (things.length) await db.one("SELECT bgc.enrich_games('', $1::jsonb, '[]'::jsonb)", [JSON.stringify(things)]);
    return { asked: ids.split(',').length, found: things.length };
  },
};
