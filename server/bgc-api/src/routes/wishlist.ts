// Wishlists. Ported from the n8n workflows Wishlist and Wishlist (add / remove) (n8n/gen.js section 29).
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { fromDb } from '../errors.js';
import { FriendQuery, parse } from '../request.js';
import { validated } from '../writes.js';

export function wishlistRoutes(db: Db) {
  return new Hono<AuthEnv>()
    // GET /vault/wishlist[?friend=<member id>]: yours, or a friend's (gift ideas); bgc.wishlist says who may see whom
    .get('/wishlist', async (c) => {
      const q = parse(FriendQuery, c.req.query(), 'That wishlist link doesn’t look right');
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.wishlist($1, $2::bigint)', [c.get('auth').email, q.friend ?? null])));
    })
    // POST /vault/wishlist { action: add|remove, bggId, title, cover }: change your own (Wishlist add / remove)
    .post('/wishlist', async (c) => {
      const v = await validated('wishChange', c);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.wish_change($1, $2, $3::int, $4, $5)', [v.email, v.action, String(v.bggId), v.title, v.cover])));
    });
}
