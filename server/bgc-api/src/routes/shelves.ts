// Shelves: Dan's collection, your own shelf, a friend's shelf, and the people and ratings that go with a shelf.
// Ported from the n8n workflows Get Collection, My Shelf, Friends (GET) and People (n8n/gen.js sections 1, 21, 29
// and 12), and their changes (Rate Game, Update / Remove My Shelf, Friends, Update / Delete Game). Rows are shaped by
// n8n's own code (shape.gen.ts), and inputs checked by its Validate nodes (validate.gen.ts).
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError, fromDb } from '../errors.js';
import { body, ownerOnly, parse } from '../request.js';
import { publicPlayer, ratingsByPlayerGame, toGame, toPlayer, toRating } from '../shape.gen.js';
import { validated } from '../writes.js';

const GAMES_TABLE = 'tblbGc0UuDxIPP2a8';
const ASK_PER_MEMBER = 30; // as in gen.js, when the database has no limit set

const byNum = (a: any, b: any) => (a.num || 0) - (b.num || 0);
const games = (records: unknown) => (Array.isArray(records) ? records : []).map(toGame).sort(byNum);

const FriendsQuery = z.object({ shelf: z.string().optional() });
const PeopleQuery = z.object({ shelf: z.string().optional() });

export function shelfRoutes(db: Db) {
  return new Hono<AuthEnv>()
    // GET /vault/collection: Dan's own shelf, a plain list. Friends see it through Friends, which checks the friendship
    .get('/collection', async (c) => {
      if (c.get('auth').role !== 'owner') throw new ApiError(403, 'Open a friend’s shelf from Friends');
      const r = await db.one<{ records?: unknown[] }>("SELECT at.request($1, 'GET', '', 'null'::jsonb, '')", [GAMES_TABLE]);
      return c.json(games(r?.records));
    })
    // GET /vault/shelf: the signed-in member's own shelf, and how their BGG import is going
    .get('/shelf', async (c) => {
      const s = (await db.one<Record<string, any>>('SELECT bgc.shelf($1)', [c.get('auth').email])) || {};
      return c.json({ ok: true, name: s.name || '', bggUsername: s.bggUsername || '', status: s.status || {}, items: games(s.records) });
    })
    // GET /vault/friends: your code and friends.  ?shelf=<member id>: that friend's shelf, view only (bgc.friend_shelf checks)
    .get('/friends', async (c) => {
      const { shelf = '' } = parse(FriendsQuery, c.req.query());
      const email = c.get('auth').email;
      let r: Record<string, any> | null;
      if (/^\d+$/.test(shelf)) {
        const id = Number(shelf);
        if (!Number.isSafeInteger(id)) throw new ApiError(400, 'That shelf link doesn’t look right');
        r = await db.one('SELECT bgc.friend_shelf($1, $2::bigint)', [email, id]);
      } else r = await db.one('SELECT bgc.friends($1)', [email]);
      r = fromDb(r ?? {});
      if (r.records) return c.json({ ok: true, name: r.name, items: games(r.records) });
      return c.json({ ok: true, code: r.code, friends: r.friends || [] });
    })
    // GET /vault/people[?shelf=mine|friend:<id>]: the people on a shelf (no emails or taste profiles), everyone's
    // ratings of its games, your own stars, and how many questions to Nathan you have left today
    .get('/people', async (c) => {
      const { shelf = '' } = parse(PeopleQuery, c.req.query());
      const a = c.get('auth');
      // The shelf view without its games (with_games false, schema/039): the people and their ratings are all this needs
      const r = await db.one<Record<string, any>>(
        "SELECT jsonb_build_object('v', v, 'mine', bgc.my_ratings_on($1, (v ->> 'ownerId')::bigint), 'used', bgc.asks_used($1), 'lim', bgc.ask_limit()) " +
        'FROM (SELECT bgc.shelf_view($1, $2, $3, false, false) AS v) q',
        [a.email, /^(mine|friend:\d+)$/.test(shelf) ? shelf : 'main', a.playerId]);
      const sv = r?.v || {};
      const players = (sv.players || []).map(toPlayer).map(publicPlayer)
        .sort((x: any, y: any) => (y.active - x.active) || x.name.localeCompare(y.name));
      const best: Record<string, Record<string, unknown>> = {}; // gameId -> playerId -> { stars, bgg }
      for (const e of Object.values(ratingsByPlayerGame((sv.ratings || []).map(toRating))) as any[]) {
        (best[e.gameId] ??= {})[e.playerId] = { ...(e.stars ? { stars: e.stars } : {}), ...(e.bgg ? { bgg: e.bgg } : {}) };
      }
      const used = Number(r?.used) || 0;
      const lim = Number(r?.lim) || ASK_PER_MEMBER;
      return c.json({ players, ratings: best, me: sv.askerKey || null, owner: sv.ownerKey || null, mine: r?.mine || {}, shelf: sv.shelf,
        asks: { limit: lim, left: Math.max(0, lim - used) } });
    })

    // ---- Changes (Rate Game, Update / Remove My Shelf, Friends add / remove, and Dan's Update / Delete Game) ----
    // POST /vault/rate { gameId, stars (0 clears) }: your own stars, for yourself only
    .post('/rate', async (c) => {
      const v = await validated('rate', c);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.rate($1, $2, $3::numeric)', [v.email, v.gameId, String(v.stars)])));
    })
    // POST /vault/shelf-update { id, fields: { favorite?, desireToPlay?, thinningCandidate?, expansions? } }: your own copy
    .post('/shelf-update', async (c) => {
      const b = await body(c);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.shelf_update($1, $2, $3::jsonb)', [c.get('auth').email, String(b.id || ''), JSON.stringify(b.fields || {})])));
    })
    // POST /vault/shelf-remove { id }: take a game off your own shelf
    .post('/shelf-remove', async (c) => {
      const b = await body(c);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.shelf_remove($1, $2)', [c.get('auth').email, String(b.id || '')])));
    })
    // POST /vault/friends { action: 'add', code } | { action: 'remove', id }: entering a code connects you both right away
    .post('/friends', async (c) => {
      const b = await body(c);
      const email = c.get('auth').email;
      const r = String(b.action || 'add') === 'remove'
        ? await db.one<Record<string, any>>("SELECT bgc.remove_friend($1, nullif($2, '')::bigint)", [email, String(Number(b.id) || '')])
        : await db.one<Record<string, any>>('SELECT bgc.add_friend($1, $2)', [email, String(b.code || '')]);
      return c.json(fromDb(r));
    })
    // POST /vault/update { id, fields }: Dan changes a game in his collection (the owner only, as in n8n)
    .post('/update', async (c) => {
      ownerOnly(c);
      const v = await validated('update', c);
      const rec = await findGame(db, v.formula, v.id);
      await db.one("SELECT at.request($1, 'PATCH', $2, $3::jsonb, '')", [GAMES_TABLE, '/' + rec.id, JSON.stringify({ fields: v.fields, typecast: true, returnFieldsByFieldId: true })]);
      return c.json({ ok: true, id: v.id });
    })
    // POST /vault/delete { id }: Dan removes a game from his collection (the owner only)
    .post('/delete', async (c) => {
      ownerOnly(c);
      const v = await validated('del', c);
      const rec = await findGame(db, v.formula, v.id);
      await db.one("SELECT at.request($1, 'DELETE', $2, 'null'::jsonb, '')", [GAMES_TABLE, '/' + rec.id]);
      return c.json({ ok: true, id: v.id, title: toGame(rec).title });
    });
}

// One of Dan's games by its id (as n8n's Find Record), or n8n's 404
async function findGame(db: Db, formula: string, id: string) {
  const r = await db.one<{ records?: any[] }>("SELECT at.request($1, 'GET', '', 'null'::jsonb, $2)", [GAMES_TABLE, formula]);
  const rec = r?.records?.[0];
  if (!rec) throw new ApiError(404, 'Game not found: ' + id);
  return rec;
}
