// Adding games to your own shelf from a photo of one box or a shelf, Dan's included. Ported from the n8n workflow Add To
// My Shelf From Photo (n8n/gen.js section 28): read the boxes, skip what's already on the shelf, look each new title up
// on BGG (most-rated exact match, loose when nothing is exact), then add it like Add To My Shelf (bgc.shelf_add puts an
// expansion under its base game), then its polish (catalog.ts). The photo is never kept.
import { Hono } from 'hono';
import { VISION_MODEL, ask, jsonIn, logAi, type AiCost } from '../ai.js';
import type { AuthEnv } from '../auth.js';
import { Bgg, normTitle } from '../bgg.js';
import { polishGame } from '../catalog.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { ApiError } from '../errors.js';
import type { Fetch } from '../http.js';
import type { Ctx } from '../request.js';
import { toGame } from '../shape.gen.js';

export type PhotoDeps = { db: Db; bgg: Bgg; openrouterKey?: string; fetch: Fetch; config: Config };

// The photo in a multipart request (field "photo"), as the vision model wants it
export async function photoIn(c: Ctx, field = 'photo'): Promise<{ b64: string; mime: string }> {
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const file = form[field];
  if (!(file instanceof File) || !file.size) throw new ApiError(400, 'No photo uploaded');
  return { b64: Buffer.from(await file.arrayBuffer()).toString('base64'), mime: file.type || 'image/jpeg' };
}

export type Seen = { title: string; kind: 'game' | 'expansion'; baseGame: string | null; owned: string | null; genre: string; type: string; desc: string };
// What the vision model found: one entry per box it could read with confidence
export function foundIn(text: string): { found: Seen[]; reason: string } {
  const r = jsonIn(text);
  const found = (Array.isArray(r.items) ? r.items : []).filter((i: any) => i && i.title && (i.confidence == null || Number(i.confidence) >= 0.5))
    .map((i: any): Seen => ({ title: String(i.title).trim(), kind: i.kind === 'expansion' ? 'expansion' : 'game', baseGame: i.baseGame ? String(i.baseGame) : null,
      owned: i.owned ? String(i.owned) : null, genre: String(i.genre || ''), type: String(i.type || ''), desc: String(i.desc || '') }));
  return { found, reason: r.reason ? String(r.reason) : '' };
}

// Which boxes are new to this shelf (8 at most per photo, to answer inside Cloudflare's 100 s), and which are already there
export function planShelfPhoto(found: Seen[], games: ReturnType<typeof toGame>[]) {
  const byTitle = new Map(games.map((g) => [normTitle(g.title), g]));
  const expansionOwner = new Map<string, ReturnType<typeof toGame>>();
  for (const g of games) for (const e of g.expansions) expansionOwner.set(normTitle(e), g);
  const skipped: { title: string; reason: string; existing?: string }[] = [], todo: Seen[] = [], deferred: string[] = [], seen = new Set<string>();
  for (const it of found) {
    const key = normTitle(it.title);
    if (seen.has(key)) continue; // the same box twice in one photo
    seen.add(key);
    const same = byTitle.get(key) || (it.owned && it.kind !== 'expansion' ? byTitle.get(normTitle(it.owned)) : null);
    if (same) { skipped.push({ title: it.title, reason: 'already on your shelf', existing: same.title }); continue; }
    const owner = expansionOwner.get(key);
    if (owner) { skipped.push({ title: it.title, reason: 'already listed as an expansion', existing: owner.title }); continue; }
    if (todo.length >= 8) { deferred.push(it.title); continue; }
    todo.push(it);
  }
  return { todo, skipped, deferred };
}

// What the vision model is asked: titles, kinds and base games, plus a genre, type and one-liner for the catalog's polish
const INSTRUCTIONS = (owned: string[]) => [
  'Identify every board game box visible in this photo (fronts, backs or spines). Skip anything you cannot read confidently.',
  'Reply with JSON only:',
  '{"items": [{"title": "official title as printed, e.g. \\"Dune: Imperium\\"", "kind": "game" or "expansion", "baseGame": "for an expansion, the title of the game it expands; else null",',
  '  "owned": "if this is the same game (any edition, spelling or language) as a title in OWNED, that exact OWNED title; else null. An expansion is never the same game as its base game",',
  '  "genre": "theme/setting, 1-2 short labels joined by \\" / \\", e.g. \\"Nature / Ecology\\"", "type": "core mechanics, 1-2 labels joined by \\" / \\", e.g. \\"Engine Building / Tableau\\"",',
  '  "desc": "one vivid sentence (max ~22 words) about what players do", "confidence": 0.0-1.0}], "reason": "only if no boxes could be identified"}',
  'Style example: {"title":"Earth","kind":"game","genre":"Nature / Ecology","type":"Engine Building / Tableau","desc":"Construct an interconnected 4x4 flora and fauna island ecosystem with zero downtime on rival turns."}',
  '', 'OWNED:', ...owned,
].join('\n');

export function shelfPhotoRoutes(d: PhotoDeps) {
  return new Hono<AuthEnv>()
    // POST /vault/shelf-identify (multipart { photo }): onto the signed-in member's own shelf
    .post('/shelf-identify', async (c) => {
      if (!d.openrouterKey) throw new ApiError(503, 'The AI service isn’t set up on this server yet');
      const photo = await photoIn(c);
      const email = c.get('auth').email;
      const shelf = (await d.db.one<Record<string, any>>('SELECT bgc.shelf($1)', [email])) || {};
      const games = (Array.isArray(shelf.records) ? shelf.records : []).map(toGame);
      const costs: AiCost[] = [];
      let a;
      try {
        a = await ask(d.openrouterKey, d.fetch, 'photo', { model: VISION_MODEL, max_tokens: 8000, reasoning: { effort: 'low' }, messages: [
          { role: 'system', content: 'You identify board games from photos for a personal collection catalog. Reply with JSON only.' },
          { role: 'user', content: [{ type: 'text', text: INSTRUCTIONS(games.map((g) => g.title).sort()) }, { type: 'image_url', image_url: { url: `data:${photo.mime};base64,${photo.b64}` } }] },
        ] });
      } catch { throw new ApiError(502, 'The photo couldn’t be read just now. Try again in a moment.'); }
      costs.push(a.cost);
      await logAi(d.db, email, costs);
      const { found, reason } = foundIn(a.text);
      if (!found.length) throw new ApiError(422, 'Could not identify a game in that photo' + (reason ? ': ' + reason : ''));
      const plan = planShelfPhoto(found, games);
      const added: any[] = [], expansions: unknown[] = [];
      const skipped = [...plan.skipped];
      for (const t of plan.todo) {
        const thing = await d.bgg.findByTitle(t.title, { fuzzy: true, want: t.kind === 'expansion' ? 'boardgameexpansion' : 'boardgame' }).catch(() => null);
        const withCover = thing ? await d.bgg.withCover(thing) : null;
        const res = (await d.db.one<Record<string, any>>('SELECT bgc.shelf_add($1, $2::jsonb, $3)', [email, JSON.stringify(withCover), t.title])) || {};
        if (res.ok) {
          added.push(...(res.added || [])); expansions.push(...(res.expansions || []));
          const key = res.added?.[0]?.id;
          if (key) await polishGame({ db: d.db, openrouterKey: d.openrouterKey, fetch: d.fetch }, email, String(key), withCover, { genre: t.genre, type: t.type, desc: t.desc });
        } else if (res.status === 409) skipped.push({ title: String(res.message || '').replace(/^"|".*$/g, ''), reason: String(res.message || '') });
      }
      return c.json({ ok: true, added, expansions, skipped, deferred: plan.deferred, title: added[0]?.title || null });
    });
}
