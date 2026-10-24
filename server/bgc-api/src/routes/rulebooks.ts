// Rulebooks. Ported from the n8n workflows Rulebook (list) and Rulebook (change / remove) (n8n/gen.js section 32).
// Uploading stays in n8n for now.
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { ApiError, fromDb } from '../errors.js';
import { parse } from '../request.js';
import { validated } from '../writes.js';

const RulebookQuery = z.object({ bgg: z.string().optional(), games: z.string().optional() });

export function rulebookRoutes(db: Db) {
  return new Hono<AuthEnv>()
    // GET /vault/rulebook?games=1: which games have documents (members only)
    // GET /vault/rulebook?bgg=<id>: one game's documents, with how far along reading each one is
    .get('/rulebook', async (c) => {
      const q = parse(RulebookQuery, c.req.query());
      const a = c.get('auth');
      if (q.games === '1') {
        if (a.memberId == null) throw new ApiError(403, 'Members only');
        return c.json({ ok: true, games: await db.one('SELECT bgc.rule_doc_games()', []) });
      }
      const bgg = Number(q.bgg) || 0;
      if (!Number.isInteger(bgg) || Math.abs(bgg) > 2147483647) throw new ApiError(400, 'Which game?');
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.rule_docs_of($1, $2::int)', [a.email, bgg])));
    })
    // POST /vault/rulebook-change { id, action: 'remove' } | { id, kind?, title?, source? }: a document's details, or remove it
    .post('/rulebook-change', async (c) => {
      const v = await validated('ruleChange', c);
      return c.json(fromDb(await db.one<Record<string, any>>('SELECT bgc.rule_doc_change($1, $2::bigint, $3, $4::jsonb)', [v.email, v.id, v.action, JSON.stringify(v.patch)])));
    });
}
