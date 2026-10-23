// Wishlists. Ported from the n8n workflow Wishlist (GET; n8n/gen.js section 29). Changing one stays in n8n for now.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { fromDb, parse } from '../errors.js';

const WishlistQuery = z.object({
  friend: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()),
});

export function wishlistRoutes(db: Db) {
  return new Hono<AuthEnv>()
    // GET /vault/wishlist[?friend=<member id>]: yours, or a friend's (gift ideas); bgc.wishlist says who may see whom
    .get('/wishlist', async (c) => {
      const q = parse(WishlistQuery, c.req.query(), 'That wishlist link doesn’t look right');
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.wishlist($1, $2::bigint)', [c.get('auth').email, q.friend ?? null])));
    });
}
