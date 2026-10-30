// Your BGG account, linked (schema/049, bggAccount.ts), and plays logged here. New with this service: n8n never had them.
//   GET  /vault/bgg-link                                      { ok, link: { linked, username, state, waiting, failed, ... } }
//   POST /vault/bgg-link { action: link, username, password }  signs in on BGG once; keeps BGG's session token, sealed
//   POST /vault/bgg-link { action: unlink }                    forgets it
//   POST /vault/bgg-link { action: settings, plays?, collection?, ratings?, location? }  what goes to BGG (BG Stats' sync switches)
//   POST /vault/log-play { gameId | bggId + title + cover, date, minutes?, location?, comments?, players: [{ name, win?, score? }] }
//        gameId: a game on your shelf; bggId: any BGG game (played at a friend's, or not owned)
//   GET  /vault/plays[?skip=n]                                 your plays, newest first, 50 at a time
//   GET  /vault/play-places                                     where you've played lately (the Where suggestions)
//   POST /vault/play-delete { id }                              one of yours; on BGG too when it's there and BGG is linked
//   POST /vault/plays-sync                                      sync now: what's waiting goes to BGG, then your BGG plays come in
//   GET  /vault/play?id=n                                       one of your plays, and whether it can be changed here
//   GET  /vault/stats[?year=yyyy]                               My stats: your plays, people, places and fun facts (schema/051)
//   POST /vault/play-edit { id, date, minutes?, location?, comments?, players }   change it (on BGG too when it's there)
// The password goes to BGG and nowhere else: it isn't logged (app.ts logs routes, never bodies), stored or sent back.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import { BggAccount, linkKey, sealToken } from '../bggAccount.js';
import type { Db } from '../db.js';
import { ApiError, fromDb } from '../errors.js';
import type { Fetch } from '../http.js';
import type { JobsClient } from '../jobsClient.js';
import { parse, parseBody } from '../request.js';

const Link = z.discriminatedUnion('action', [
  z.object({ action: z.literal('link'), username: z.string().trim().regex(/^[A-Za-z0-9_ .-]{2,40}$/), password: z.string().min(1).max(200) }),
  z.object({ action: z.literal('unlink') }),
  z.object({ action: z.literal('settings'), plays: z.boolean().optional(), collection: z.boolean().optional(), ratings: z.boolean().optional(), location: z.boolean().optional() }),
]);

const today = () => new Date().toISOString().slice(0, 10);
const LogPlay = z.object({
  gameId: z.string().min(1).max(40).optional(),
  bggId: z.coerce.number().int().positive().max(99_999_999).optional(),
  title: z.string().trim().max(200).optional().default(''),
  cover: z.string().url().max(500).optional().or(z.literal('')).default(''),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !isNaN(Date.parse(d)) && d >= '1990-01-01' && d <= today(), 'date'),
  minutes: z.coerce.number().int().min(0).max(24 * 60).optional().nullable(),
  location: z.string().trim().max(100).optional().default(''),
  comments: z.string().max(2000).optional().default(''),
  players: z.array(z.object({ name: z.string().trim().min(1).max(60), win: z.boolean().optional().default(false),
    // left out on an edit: the score the play had stays (one from BGG or BG Stats isn't lost)
    score: z.union([z.string(), z.number()]).transform((v) => String(v).trim()).pipe(z.string().max(20)).optional() })).min(1).max(20),
}).refine((p) => !!p.gameId !== !!p.bggId, 'one game');
const Skip = z.object({ skip: z.coerce.number().int().min(0).max(100_000).optional().default(0) });
const PlayId = z.object({ id: z.coerce.number().int().positive() });
const StatsYear = z.object({ year: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1970).max(2100).optional()) });
const PlayEdit = z.object({ id: z.coerce.number().int().positive(), date: LogPlay.shape.date, minutes: LogPlay.shape.minutes,
  location: LogPlay.shape.location, comments: LogPlay.shape.comments, players: LogPlay.shape.players });

// Sign-in tries per member, so the route can't be used to guess someone's BGG password: 5 an hour
const TRIES = 5, WINDOW = 60 * 60 * 1000;

export function bggLinkRoutes(db: Db, deps: { fetch: Fetch; linkKey: string | undefined; jobs: JobsClient; now?: () => number }) {
  const acct = new BggAccount(deps.fetch, 0); // a sign-in is one request; the worker paces the writes
  const tries = new Map<number | string, number[]>();
  const now = deps.now ?? Date.now;
  const kick = () => deps.jobs.run('bggOutbox', {}).catch(() => null);
  return new Hono<AuthEnv>()
    .get('/bgg-link', async (c) => {
      const link = await db.one<Record<string, any>>('SELECT bgc.bgg_link_status($1)', [c.get('auth').email]);
      return c.json({ ok: true, ready: !!linkKey(deps.linkKey), link });
    })
    .post('/bgg-link', async (c) => {
      const a = c.get('auth');
      const b = await parseBody(c, Link, 'Enter your BoardGameGeek username and password');
      if (b.action === 'unlink') return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.bgg_link_remove($1)', [a.email])));
      if (b.action === 'settings') {
        const { action, ...s } = b;
        return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.bgg_link_settings($1, $2::jsonb)', [a.email, JSON.stringify(s)])));
      }
      const key = linkKey(deps.linkKey);
      if (!key) throw new ApiError(503, 'Linking BGG isn’t set up yet');
      const who = a.memberId ?? a.email, t = now();
      const recent = (tries.get(who) || []).filter((x) => t - x < WINDOW);
      if (recent.length >= TRIES) throw new ApiError(429, 'That’s a few tries. Wait an hour, or check your password on boardgamegeek.com.');
      tries.set(who, [...recent, t]);
      const r = await acct.login(b.username, b.password);
      if (!r.ok) throw r.reason === 'password'
        ? new ApiError(400, 'BGG didn’t accept that username and password')
        : new ApiError(503, 'BGG isn’t answering right now. Try again in a minute.');
      tries.delete(who);
      const saved = fromDb(await db.one<Record<string, any>>('SELECT bgc.bgg_link_save($1, $2, $3, $4::timestamptz)', [a.email, b.username, sealToken(key, r.token), r.expires]));
      await kick();
      return c.json(saved);
    })
    .post('/log-play', async (c) => {
      const b = await parseBody(c, LogPlay, 'Pick a day and at least one player');
      const r = fromDb(await db.one<Record<string, any>>('SELECT bgc.log_play($1, $2, $3::jsonb)', [c.get('auth').email, b.gameId ?? null, JSON.stringify(b)]));
      if (r.toBgg) await kick();
      return c.json(r);
    })
    .get('/plays', async (c) => {
      const q = parse(Skip, c.req.query(), 'That page of plays doesn’t look right');
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.my_plays($1, $2, 50)', [c.get('auth').email, q.skip])));
    })
    .get('/play-places', async (c) => c.json({ ok: true, places: (await db.one<string[]>('SELECT bgc.play_places($1)', [c.get('auth').email])) || [] }))
    .post('/plays-sync', async (c) => {
      const email = c.get('auth').email;
      const p = await db.one<Record<string, any>>('SELECT bgc.my_plays($1, 0, 1)', [email]);
      const username = String(p?.bggUsername || '').trim();
      if (!username) throw new ApiError(400, 'Link BGG in My profile (or add your BGG username) to sync your plays');
      // Sends first, so the plays coming back include them; a run already going counts (it takes everything waiting)
      if (p?.linked) await deps.jobs.run('bggOutbox', {}, { wait: true }).catch(() => null);
      const start = await db.one<{ ok: boolean; message?: string }>('SELECT bgc.start_import($1, $2)', [email, username]);
      if (start?.ok) await deps.jobs.run('memberPlays', { email, username });
      return c.json({ ok: true, started: !!start?.ok, running: !start?.ok });
    })
    .get('/stats', async (c) => {
      const q = parse(StatsYear, c.req.query(), 'Pick a year');
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.my_stats($1, $2::int)', [c.get('auth').email, q.year ?? null])));
    })
    .get('/play', async (c) => {
      const q = parse(PlayId, c.req.query(), 'Which play?');
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.play_get($1, $2)', [c.get('auth').email, q.id])));
    })
    .post('/play-edit', async (c) => {
      const { id, ...p } = await parseBody(c, PlayEdit, 'Pick a day and at least one player');
      const r = fromDb(await db.one<Record<string, any>>('SELECT bgc.play_edit($1, $2, $3::jsonb)', [c.get('auth').email, id, JSON.stringify(p)]));
      if (r.toBgg) await kick();
      return c.json(r);
    })
    .post('/play-delete', async (c) => {
      const b = await parseBody(c, PlayId, 'Which play?');
      const r = fromDb(await db.one<Record<string, any>>('SELECT bgc.play_delete($1, $2)', [c.get('auth').email, b.id]));
      if (r.fromBgg) await kick();
      return c.json(r);
    });
}
