// A member adds games to their own shelf from a photo. Ported from the n8n workflow Add To My Shelf From Photo
// (n8n/gen.js section 28): read the boxes, skip what's already on their shelf, look each new title up on BGG (most-rated
// exact match, loose when nothing is exact), then add it like Add To My Shelf (bgc.shelf_add: expansions go under their
// base game). The photo is never kept.
import { Hono } from 'hono';
import { VISION_MODEL, ask, jsonIn, logAi, type AiCost } from '../ai.js';
import type { AuthEnv } from '../auth.js';
import { normTitle } from '../bgg.js';
import { ApiError } from '../errors.js';
import { toGame } from '../shape.gen.js';
import { photoIn, type CollectionDeps } from './collection.js';

type Seen = { title: string; kind: 'game' | 'expansion'; baseGame: string | null; owned: string | null };

// Which boxes are new to this shelf (8 at most per photo), and which are already there
export function planShelfPhoto(found: Seen[], games: ReturnType<typeof toGame>[]) {
  const byTitle = new Map(games.map((g) => [normTitle(g.title), g]));
  const expansionOwner = new Map<string, ReturnType<typeof toGame>>();
  for (const g of games) for (const e of g.expansions) expansionOwner.set(normTitle(e), g);
  const skipped: { title: string; reason: string; existing?: string }[] = [], todo: Seen[] = [], deferred: string[] = [], seen = new Set<string>();
  for (const it of found) {
    const key = normTitle(it.title);
    if (seen.has(key)) continue;
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

export function shelfPhotoRoutes(d: CollectionDeps) {
  return new Hono<AuthEnv>()
    // POST /vault/shelf-identify (multipart { photo }): onto the signed-in member's own shelf
    .post('/shelf-identify', async (c) => {
      if (!d.openrouterKey) throw new ApiError(503, 'The AI service isn’t set up on this server yet');
      const photo = await photoIn(c);
      const email = c.get('auth').email;
      const shelf = (await d.db.one<Record<string, any>>('SELECT bgc.shelf($1)', [email])) || {};
      const games = (Array.isArray(shelf.records) ? shelf.records : []).map(toGame);
      const instructions = [
        'Identify every board game box visible in this photo (fronts, backs or spines). Skip anything you cannot read confidently.',
        'Reply with JSON only:',
        '{"items": [{"title": "official title as printed", "kind": "game" or "expansion", "baseGame": "for an expansion, the game it expands; else null",',
        '  "owned": "if this is the same game (any edition, spelling or language) as a title in OWNED, that exact OWNED title; else null. An expansion is never the same game as its base game",',
        '  "confidence": 0.0-1.0}], "reason": "only if no boxes could be identified"}',
        '', 'OWNED:', ...games.map((g) => g.title).sort(),
      ].join('\n');
      const costs: AiCost[] = [];
      let a;
      try {
        a = await ask(d.openrouterKey, d.fetch, 'photo', { model: VISION_MODEL, max_tokens: 4000, reasoning: { enabled: false }, messages: [
          { role: 'system', content: 'You identify board games from photos for a personal collection catalog. Reply with JSON only.' },
          { role: 'user', content: [{ type: 'text', text: instructions }, { type: 'image_url', image_url: { url: `data:${photo.mime};base64,${photo.b64}` } }] },
        ] });
      } catch { throw new ApiError(502, 'The photo couldn’t be read just now. Try again in a moment.'); }
      costs.push(a.cost);
      await logAi(d.db, email, costs);
      const r = jsonIn(a.text);
      const found: Seen[] = (Array.isArray(r.items) ? r.items : []).filter((i: any) => i && i.title && (i.confidence == null || Number(i.confidence) >= 0.5))
        .map((i: any) => ({ title: String(i.title).trim(), kind: i.kind === 'expansion' ? 'expansion' : 'game', baseGame: i.baseGame ? String(i.baseGame) : null, owned: i.owned ? String(i.owned) : null }));
      if (!found.length) throw new ApiError(422, 'Could not identify a game in that photo' + (r.reason ? ': ' + r.reason : ''));
      const plan = planShelfPhoto(found, games);
      const added: unknown[] = [], expansions: unknown[] = [];
      const skipped = [...plan.skipped];
      for (const t of plan.todo) {
        const thing = await d.bgg.findByTitle(t.title, { fuzzy: true, want: t.kind === 'expansion' ? 'boardgameexpansion' : 'boardgame' }).catch(() => null);
        const withCover = thing ? await d.bgg.withCover(thing) : null;
        const res = (await d.db.one<Record<string, any>>('SELECT bgc.shelf_add($1, $2::jsonb, $3)', [email, JSON.stringify(withCover), t.title])) || {};
        if (res.ok) { added.push(...(res.added || [])); expansions.push(...(res.expansions || [])); }
        else if (res.status === 409) skipped.push({ title: String(res.message || '').replace(/^"|".*$/g, ''), reason: String(res.message || '') });
      }
      return c.json({ ok: true, added, expansions, skipped, deferred: plan.deferred, title: (added[0] as any)?.title || null });
    });
}
