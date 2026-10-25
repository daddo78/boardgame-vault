// The slow adds, answered right away and finished by the jobs worker: a member's plays from BGG (Connect BGG Plays),
// a spreadsheet of games (Add To My Shelf From CSV), and Dan's "Sync plays now" (which waits for its result).
// Ported from n8n/gen.js sections 24, 24b and 7; progress shows on /shelf (members.import_status).
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError, fromDb } from '../errors.js';
import type { JobsClient } from '../jobsClient.js';
import { body, ownerOnly } from '../request.js';

export function importRoutes(db: Db, jobs: JobsClient) {
  return new Hono<AuthEnv>()
    // POST /vault/import { bggUsername }: remember the username and bring in their plays (no games)
    .post('/import', async (c) => {
      const username = String((await body(c)).bggUsername || '').trim();
      if (!/^[A-Za-z0-9_ .-]{2,40}$/.test(username)) throw new ApiError(400, 'Enter your BoardGameGeek username');
      const email = c.get('auth').email;
      const r = await db.one<{ ok: boolean; message?: string }>('SELECT bgc.start_import($1, $2)', [email, username]);
      if (!r?.ok) throw new ApiError(409, r?.message || 'An import is already running');
      await jobs.run('memberPlays', { email, username });
      return c.json({ ok: true, started: true });
    })
    // POST /vault/shelf-csv { rows: [{ title, bggId, year }] }: the fast way to fill a big shelf
    .post('/shelf-csv', async (c) => {
      const b = await body(c);
      const rows: any[] = Array.isArray(b.rows) ? b.rows : [];
      if (rows.length > 2000) throw new ApiError(400, 'That’s more than 2,000 games. Split the file in two.');
      const clean = rows.map((r) => ({ title: String((r && r.title) || '').trim().slice(0, 200), bggId: String((r && r.bggId) || '').replace(/\D/g, '').slice(0, 7),
        year: String((r && r.year) || '').replace(/\D/g, '').slice(0, 4) })).filter((r) => r.title || r.bggId);
      if (!clean.length) throw new ApiError(400, 'No game names found in that file');
      const email = c.get('auth').email;
      const start = fromDb(await db.one<Record<string, any>>('SELECT bgc.start_csv($1, $2::jsonb)', [email, JSON.stringify(clean)]));
      await jobs.run('shelfCsv', { email, start: { ids: start.ids || [], search: start.search || [], alreadyHad: start.alreadyHad || 0 } });
      return c.json({ ok: true, started: true, matched: (start.ids || []).length, lookingUp: (start.search || []).length, alreadyHad: start.alreadyHad || 0 });
    })
    // POST /vault/sync-plays: Dan's plays from BGG now (the owner only); waits for the result, as n8n did
    .post('/sync-plays', async (c) => {
      ownerOnly(c);
      const r = await jobs.run('syncPlays', {}, { wait: true });
      const res: any = r.result;
      if (res && typeof res === 'object' && res.error) throw new ApiError(502, String(res.error));
      return c.json({ ok: true, ...(res && typeof res === 'object' ? res : {}) });
    });
}
