// Who's signed in, profiles, and what Nathan remembers. Ported from the n8n workflows Who Am I, My Profile,
// Profile Page and Nathan Memory (n8n/gen.js sections 11, 19, 30 and 36); the answers are the same JSON the page reads today.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import { myProfile, profilePage, type Db } from '../db.js';
import { fromDb, parse } from '../errors.js';
import { validated } from '../writes.js';

const MemoryQuery = z.object({ chat: z.string().optional() });

const ProfileQuery =z.object({
  friend: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()),
});

export function profileRoutes(db: Db) {
  return new Hono<AuthEnv>()
    // GET /vault/whoami: right after Google sign-in, what this person may do
    .get('/whoami', (c) => {
      const a = c.get('auth');
      return c.json({ ok: true, role: a.role, owner: a.role === 'owner', playerId: a.playerId, playerName: a.playerName, admin: a.admin });
    })
    // GET /vault/me: the signed-in person's own profile
    .get('/me', async (c) => c.json({ ok: true, profile: (await myProfile(db, c.get('auth').email)) ?? null }))
    // GET /vault/profile[?friend=<member id>]: your own profile, or a friend's (bgc.profile_page says who may see whom)
    .get('/profile', async (c) => {
      const q = parse(ProfileQuery, c.req.query(), 'That profile link doesn’t look right');
      return c.json(fromDb(await profilePage(db, c.get('auth').email, q.friend ?? null)));
    })
    // GET /vault/memory[?chat=<key>]: what Nathan remembers about you, and one saved chat to show again
    .get('/memory', async (c) => {
      const chat = String(parse(MemoryQuery, c.req.query()).chat || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.memory_page($1, $2)', [c.get('auth').email, chat])));
    })
    // POST /vault/me-save { bggUsername, age, dials, likes, dislikes, notes, topGames? }: your own profile (Save My Profile)
    .post('/me-save', async (c) => {
      const v = await validated('meSave', c);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.save_profile($1, $2::jsonb)', [v.email, JSON.stringify(v.profile)])));
    })
    // POST /vault/memory { action: 'forget', id } | { action: 'forgetAll' }: what Nathan remembers (Nathan Forget)
    .post('/memory', async (c) => {
      const v = await validated('memoryForget', c);
      return c.json(fromDb(await db.one<Record<string, any>>("SELECT bgc.memory_forget($1, nullif($2, '')::bigint)", [v.email, v.id])));
    });
}
