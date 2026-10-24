// Who gets Nathan from this service instead of n8n: 'off', 'admins' or 'everyone' (settings key nathan_api).
//   GET  /vault/nathan-mode           { ok, useApi } for the signed-in member (plus mode, for admins)
//   POST /vault/nathan-mode { mode }  admins only
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import { parseBody } from '../request.js';
import { Mode, modeOf, modeOn } from '../settings.js';

export const readMode = async (db: Db): Promise<Mode> => modeOf(await db.one<string>("SELECT value #>> '{}' FROM settings WHERE key = 'nathan_api'", []));

export function nathanModeRoutes(db: Db, ready: boolean) {
  return new Hono<AuthEnv>()
    .get('/nathan-mode', async (c) => {
      const a = c.get('auth');
      const mode = await readMode(db);
      return c.json({ ok: true, useApi: ready && modeOn(mode, a), ...(a.admin ? { mode } : {}) });
    })
    .post('/nathan-mode', async (c) => {
      if (!c.get('auth').admin) throw new ApiError(403, 'Admins only');
      const { mode } = await parseBody(c, z.object({ mode: Mode }), 'Pick off, admins or everyone');
      await db.one("INSERT INTO settings (key, value, updated_at) VALUES ('nathan_api', to_jsonb($1::text), now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [mode]);
      return c.json({ ok: true, mode });
    });
}
