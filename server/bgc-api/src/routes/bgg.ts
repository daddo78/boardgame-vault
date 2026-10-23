// BoardGameGeek: searching it, and adding a game from it to your own shelf. Ported from the n8n workflows Search BGG
// and Add To My Shelf (n8n/gen.js sections 9 and 27); their code nodes run word for word (nodes.gen.ts), so results
// are found, ranked and shaped exactly as before. Adding to Dan's own collection (Add Game By Name: AI blurb, BGG
// details, icon) stays in n8n.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError, fromDb } from '../errors.js';
import type { Fetch } from '../nathan/openrouter.js';
import { runNode } from '../nodes.js';
import { body } from './shelves.js';

export type BggDeps = { db: Db; bggToken?: string; fetch?: Fetch };

const BGG = 'https://boardgamegeek.com/xmlapi2/';
const UNAVAILABLE = 'BoardGameGeek isn’t answering right now. Try again in a minute.';

// BGG's XML API, with our token. It sometimes answers 202 ("ask again soon") or 429: one more try after 2 seconds.
// null when it still can't answer.
async function bggText(f: Fetch, token: string | undefined, url: string): Promise<string | null> {
  if (!token) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2000));
    try {
      const r = await f(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(20_000) });
      if (r.ok && r.status !== 202) return await r.text();
    } catch { /* try again */ }
  }
  return null;
}

export function bggRoutes({ db, bggToken, fetch: f = fetch }: BggDeps) {
  return new Hono<AuthEnv>()
    // GET /vault/bgg-search?q=<title>: up to 12 BGG games and expansions, exact and prefix matches first
    .get('/bgg-search', async (c) => {
      const v = fromDb(runNode('bggSearch', 'Validate', { query: c.req.query() }));
      const search = await bggText(f, bggToken, BGG + 'search?' + new URLSearchParams({ query: v.q, type: 'boardgame,boardgameexpansion' }));
      if (search == null) throw new ApiError(502, UNAVAILABLE);
      const pick = runNode('bggSearch', 'Pick Ids', { data: search }, { Validate: v });
      if (!pick.found) return c.json({ results: [] });
      const things = await bggText(f, bggToken, BGG + 'thing?' + new URLSearchParams({ id: pick.ids, stats: '1' }));
      if (things == null) throw new ApiError(502, UNAVAILABLE);
      return c.json(runNode('bggSearch', 'Shape Results', { data: things }, { Validate: v }));
    })
    // POST /vault/shelf-add { bggId } | { title }: onto your own shelf. A game someone already has comes from the shared
    // catalog; a new one gets its BGG details and box art (bgc.shelf_add decides, as for n8n)
    .post('/shelf-add', async (c) => {
      const v = fromDb(runNode('shelfAdd', 'Validate', { body: await body(c), _auth: c.get('auth') }));
      let thing = null;
      if (v.bggId) {
        const data = await bggText(f, bggToken, BGG + 'thing?' + new URLSearchParams({ id: String(v.bggId), stats: '1' }));
        if (data == null) throw new ApiError(502, UNAVAILABLE);
        const parsed = fromDb(runNode('shelfAdd', 'Parse Thing', { data }, { Validate: v }));
        // Box art sizes from BGG's image service; without them the game is still added, just without a cover
        let images = {};
        try {
          const r = await f('https://api.geekdo.com/api/images/' + (parsed.thing.picId || 0), { signal: AbortSignal.timeout(20_000) });
          if (r.ok) images = await r.json();
        } catch { /* no cover */ }
        thing = runNode('shelfAdd', 'Add Cover', images, { 'Parse Thing': parsed }).thing;
      }
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.shelf_add($1, $2::jsonb, $3)', [v.email, JSON.stringify(thing), v.title])));
    });
}
