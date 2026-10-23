// Which parts of the site the page asks this service for instead of n8n, one switch per area (ROADMAP 7, Phase 3).
// Each area is 'off', 'admins' or 'everyone', like Nathan's switch; settings key api_areas holds { area: mode }.
//   GET  /vault/routes                  { ok, routes: ['GET /shelf', ...] } the signed-in member's page sends here
//   GET  /vault/api-areas               admins: { ok, areas: { shelves: 'off', ... } }
//   POST /vault/api-areas { area, mode } admins
// An area goes on only after Admin's API check shows the same answers as n8n; if this service can't be reached, the
// page asks n8n anyway. Nathan keeps his own switch (nathan-mode) until it goes, around Nov 6.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError, parse } from '../errors.js';
import { readMode } from './nathanMode.js';

export const AREAS = {
  account: ['GET /whoami', 'GET /me', 'GET /profile', 'GET /memory'],
  shelves: ['GET /collection', 'GET /shelf', 'GET /people', 'GET /friends'],
  wishlist: ['GET /wishlist'],
  rulebooks: ['GET /rulebook'],
  admin: ['GET /admin', 'GET /dashboard', 'GET /costs', 'GET /players-admin'],
  // Changes have their own switches, so a new one starts off even where the reads are already on
  accountChanges: ['POST /me-save', 'POST /memory'],
  wishlistChanges: ['POST /wishlist'],
  rulebookChanges: ['POST /rulebook-change'],
  shelfChanges: ['POST /rate', 'POST /shelf-update', 'POST /shelf-remove', 'POST /update', 'POST /delete'],
  friendChanges: ['POST /friends'],
  adminChanges: ['POST /player-save', 'POST /costs'],
  addGames: ['GET /bgg-search', 'POST /shelf-add'],
} as const;
type Area = keyof typeof AREAS;

const Mode = z.enum(['off', 'admins', 'everyone']);
type Mode = z.infer<typeof Mode>;
const AreaName = z.enum(Object.keys(AREAS) as [Area, ...Area[]]);

const readAreas = async (db: Db): Promise<Record<Area, Mode>> => {
  const saved = (await db.one<Record<string, unknown>>("SELECT value FROM settings WHERE key = 'api_areas'", [])) || {};
  return Object.fromEntries((Object.keys(AREAS) as Area[]).map((a) => [a, Mode.safeParse(saved[a]).success ? saved[a] : 'off'])) as Record<Area, Mode>;
};

export function areaRoutes(db: Db, nathanReady: boolean) {
  return new Hono<AuthEnv>()
    .get('/routes', async (c) => {
      const a = c.get('auth');
      const on = (m: Mode) => m === 'everyone' || (m === 'admins' && a.admin);
      const [areas, nathan] = await Promise.all([readAreas(db), readMode(db)]);
      const routes: string[] = (Object.keys(AREAS) as Area[]).filter((k) => on(areas[k])).flatMap((k) => AREAS[k]);
      if (nathanReady && on(nathan)) routes.push('POST /ask');
      return c.json({ ok: true, routes });
    })
    .get('/api-areas', async (c) => {
      if (!c.get('auth').admin) throw new ApiError(403, 'Admins only');
      return c.json({ ok: true, areas: await readAreas(db), routes: AREAS });
    })
    .post('/api-areas', async (c) => {
      if (!c.get('auth').admin) throw new ApiError(403, 'Admins only');
      const { area, mode } = parse(z.object({ area: AreaName, mode: Mode }), await c.req.json().catch(() => null), 'Pick an area and off, admins or everyone');
      await db.one("INSERT INTO settings (key, value, updated_at) VALUES ('api_areas', jsonb_build_object($1::text, $2::text), now()) " +
        'ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now()', [area, mode]);
      return c.json({ ok: true, areas: await readAreas(db) });
    });
}
