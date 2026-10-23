// Admin reads: the Admin overview, the dashboard, costs, and Dan's people list. Ported from the n8n workflows Admin,
// Dashboard, Costs (GET) and Players Admin (n8n/gen.js sections 31, 33, 41 and 15). The bgc.* functions say who's an admin.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError, fromDb } from '../errors.js';
import { toPlayer } from '../shape.gen.js';

const PLAYERS_TABLE = 'tblNahVdHDueJJ0w4';

export function adminRoutes(db: Db) {
  const read = (sql: string) => async (c: any) => c.json(fromDb(await db.one<Record<string, any>>(sql, [c.get('auth').email])));
  return new Hono<AuthEnv>()
    // GET /vault/admin: site-wide usage, every member, every rulebook and the feedback
    .get('/admin', read("SELECT bgc.admin_overview($1) || CASE WHEN bgc.is_admin($1) THEN jsonb_build_object('rulebooks', bgc.rule_docs_all($1)) ELSE '{}'::jsonb END || jsonb_strip_nulls(jsonb_build_object('feedback', bgc.feedback_all($1)))"))
    // GET /vault/dashboard: how people use the site, plus last night's self-test
    .get('/dashboard', read("SELECT CASE WHEN (d ->> 'ok')::boolean THEN d || jsonb_build_object('selfTest', (SELECT value FROM settings WHERE key = 'self_test')) ELSE d END FROM (SELECT bgc.dashboard($1) AS d) q"))
    // GET /vault/costs: what the site costs to run
    .get('/costs', read('SELECT bgc.costs_page($1)'))
    // GET /vault/players-admin: Dan's people with emails and play counts (the owner only, as in n8n)
    .get('/players-admin', async (c) => {
      if (c.get('auth').role !== 'owner') throw new ApiError(401, 'Sign in as the collection owner to make changes');
      const r = await db.one<{ records?: unknown[] }>("SELECT at.request($1, 'GET', '', 'null'::jsonb, '')", [PLAYERS_TABLE]);
      const players = (r?.records || []).map(toPlayer)
        .map(({ history, ...p }: any) => ({ ...p, games: Object.keys(history).length, plays: Object.values(history).reduce((n: number, h: any) => n + (h.plays || 0), 0) }))
        .sort((a: any, b: any) => (b.active - a.active) || (b.plays - a.plays) || a.name.localeCompare(b.name));
      return c.json({ players });
    });
}
