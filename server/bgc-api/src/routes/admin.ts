// Admin reads: the Admin overview, the dashboard, costs, and the owner's Players screen. Ported from the n8n workflows
// Admin, Dashboard, Costs and Players Admin (n8n/gen.js sections 31, 33, 41 and 15), with Save Player, fixed costs and
// Admin's member actions (invites send a welcome email). The bgc.* functions say who's an admin; since 2026-10-25 the
// Players screen goes through bgc.players_admin / bgc.player_save instead of the Airtable adapter.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { fromDb } from '../errors.js';
import type { Fetch } from '../http.js';
import { sendMail } from '../mail.js';
import { runNode } from '../nodes.js';
import { body, type Ctx } from '../request.js';
import { toPlayer } from '../shape.gen.js';
import { validated } from '../writes.js';

export function adminRoutes(db: Db, mail: { resendKey?: string; fetch?: Fetch } = {}) {
  const read = (sql: string) => async (c: Ctx) => c.json(fromDb(await db.one<Record<string, any>>(sql, [c.get('auth').email])));
  return new Hono<AuthEnv>()
    // GET /vault/admin: site-wide usage, every member, every rulebook and the feedback
    .get('/admin', read("SELECT bgc.admin_overview($1) || CASE WHEN bgc.is_admin($1) THEN jsonb_build_object('rulebooks', bgc.rule_docs_all($1)) ELSE '{}'::jsonb END || jsonb_strip_nulls(jsonb_build_object('feedback', bgc.feedback_all($1)))"))
    // GET /vault/dashboard: how people use the site, last night's self-test, and the thumbs on Nathan's replies
    .get('/dashboard', read("SELECT CASE WHEN (d ->> 'ok')::boolean THEN d || jsonb_build_object('selfTest', (SELECT value FROM settings WHERE key = 'self_test'), 'votes', bgc.ask_votes_admin($1)) ELSE d END FROM (SELECT bgc.dashboard($1) AS d) q"))
    // GET /vault/costs: what the site costs to run
    .get('/costs', read('SELECT bgc.costs_page($1)'))
    // GET /vault/players-admin: the owner's people with emails and play counts (admins; the database checks)
    .get('/players-admin', async (c) => {
      const r = fromDb(await db.one<Record<string, any>>('SELECT bgc.players_admin($1)', [c.get('auth').email]));
      const players = (Array.isArray(r.records) ? r.records : []).map(toPlayer)
        .map(({ history, ...p }: any) => ({ ...p, games: Object.keys(history).length, plays: Object.values(history).reduce((n: number, h: any) => n + (h.plays || 0), 0) }))
        .sort((a: any, b: any) => (b.active - a.active) || (b.plays - a.plays) || a.name.localeCompare(b.name));
      return c.json({ players });
    })
    // POST /vault/player-save { id?, name, aliases, active, googleEmail, bggUsername }: a card in the owner's people (admins; Save Player's checks)
    .post('/player-save', async (c) => {
      const v = await validated('playerSave', c);
      const r = fromDb(await db.one<Record<string, any>>('SELECT bgc.player_save($1, $2, $3::jsonb)', [c.get('auth').email, v.id || null, JSON.stringify(v.fields)]));
      return c.json({ ok: true, player: toPlayer(r.record || {}) });
    })
    // POST /vault/admin { action: invite|remove|admin|resetAsks|askLimit, target, email, name, on, value }: Admin's
    // member actions (bgc.admin_action checks admins). A new member gets a welcome email, written by n8n's own code
    .post('/admin', async (c) => {
      const v = fromDb(runNode('adminAction', 'Validate', { body: await body(c), _auth: c.get('auth') }));
      const r = fromDb(await db.one<Record<string, any>>("SELECT bgc.admin_action($1, $2, nullif($3, '')::bigint, $4::jsonb)", [v.email, v.action, v.target, JSON.stringify(v.v)]));
      if (v.action !== 'invite') return c.json(r);
      const m = runNode('adminAction', 'Invite Email', null, { Validate: v, 'Auth: Role': { _auth: c.get('auth') } });
      const sent = await sendMail(mail.fetch ?? fetch, mail.resendKey, { to: m.to, subject: m.subject, text: m.text, html: m.html, replyTo: m.replyTo });
      return c.json(runNode('adminAction', 'Invited', sent ? {} : { error: 'not sent' }, { Result: r }));
    })
    // POST /vault/costs { fixed: [{ name, amount, per }] }: the fixed costs on Admin → Costs (bgc.costs_fixed_save checks admins)
    .post('/costs', async (c) => {
      const b = await body(c);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.costs_fixed_save($1, $2::jsonb)', [c.get('auth').email, JSON.stringify(Array.isArray(b.fixed) ? b.fixed.slice(0, 20) : [])])));
    });
}
