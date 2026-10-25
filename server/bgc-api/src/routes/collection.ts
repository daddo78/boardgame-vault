// Adding to Dan's own collection (the owner only): by name, and from a photo of one box or a shelf. Ported from the n8n
// workflows Add Game By Name and Identify Games From Photo (n8n/gen.js sections 10 and 4). Owned games are refused, an
// expansion of an owned game is listed under it, anything else is created, then looked up on BGG (details, box art,
// plays) and given an icon (catalog.ts). A photo is read by the vision model and never kept.
import { Hono } from 'hono';
import { VISION_MODEL, ask, jsonIn, logAi, type AiCost } from '../ai.js';
import { Bgg, normTitle, type Thing } from '../bgg.js';
import { assignIcon, createGames, deleteGame, enrichGame, listGames, newGameFields, nextNum, ownerBggUsername, patchGame, patchGames, writeBlurb, type Game } from '../catalog.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { AuthEnv } from '../auth.js';
import { ApiError } from '../errors.js';
import { F } from '../fields.js';
import type { Fetch } from '../http.js';
import { body, ownerOnly, type Ctx } from '../request.js';
import { toGame } from '../shape.gen.js';

export type CollectionDeps = { db: Db; bgg: Bgg; openrouterKey?: string; fetch: Fetch; config: Config };

// The photo in a multipart request (field "photo"), as the vision model wants it
export async function photoIn(c: Ctx, field = 'photo'): Promise<{ b64: string; mime: string }> {
  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const file = form[field];
  if (!(file instanceof File) || !file.size) throw new ApiError(400, 'No photo uploaded');
  return { b64: Buffer.from(await file.arrayBuffer()).toString('base64'), mime: file.type || 'image/jpeg' };
}

// What the vision model found in a photo: one entry per box it could read with confidence
export type Found = { title: string; kind: 'game' | 'expansion'; baseGame: string | null; owned: string | null; genre: string; type: string; desc: string };
export function foundIn(text: string): { found: Found[]; reason: string } {
  const r = jsonIn(text);
  const found = (Array.isArray(r.items) ? r.items : []).filter((i: any) => i && i.title && (i.confidence == null || Number(i.confidence) >= 0.5))
    .map((i: any): Found => ({ title: String(i.title).trim(), kind: i.kind === 'expansion' ? 'expansion' : 'game', baseGame: i.baseGame ? String(i.baseGame) : null,
      owned: i.owned ? String(i.owned) : null, genre: String(i.genre || ''), type: String(i.type || ''), desc: String(i.desc || '') }));
  return { found, reason: r.reason ? String(r.reason) : '' };
}

// Dan's collection photo: what to skip, which expansions to list under their game, and which games to create (8 at most
// per photo, to answer inside Cloudflare's 100 s)
export function planCollectionPhoto(found: Found[], games: Game[]) {
  const byTitle = new Map(games.map((g) => [normTitle(g.title), g]));
  const expansionOwner = new Map<string, Game>();
  for (const g of games) for (const e of g.expansions) expansionOwner.set(normTitle(e), g);
  const skipped: { title: string; reason: string; existing?: string }[] = [], expansions: { title: string; base: string }[] = [], deferred: string[] = [];
  const creates: { gameId: string; title: string; fields: Record<string, unknown> }[] = [];
  const seen = new Set<string>();
  const expUpdates = new Map<string, { game: Game; list: string[] }>();
  let num = Math.max(0, ...games.map((g) => Number(g.num) || 0));
  for (const it of found) {
    const key = normTitle(it.title);
    if (seen.has(key)) continue; // same box twice in one photo
    seen.add(key);
    const sameTitle = byTitle.get(key);
    const modelMatch = it.owned ? byTitle.get(normTitle(it.owned)) : null;
    // For an expansion, the model sometimes points "owned" at the base game; that means "expansion of", not "duplicate"
    const modelDupe = modelMatch && !(it.kind === 'expansion' && normTitle(modelMatch.title) !== key) ? modelMatch : null;
    if (sameTitle || modelDupe) { skipped.push({ title: it.title, reason: 'already in your collection', existing: (sameTitle || modelDupe)!.title }); continue; }
    const owner = expansionOwner.get(key);
    if (owner) { skipped.push({ title: it.title, reason: 'already listed as an expansion', existing: owner.title }); continue; }
    if (it.kind === 'expansion') {
      // Base game: what the model named, else the longest owned title the expansion's name starts with
      const base = (it.baseGame && byTitle.get(normTitle(it.baseGame))) || modelMatch
        || games.filter((g) => key.startsWith(normTitle(g.title) + ' ')).sort((a, b) => b.title.length - a.title.length)[0];
      if (base) {
        const u = expUpdates.get(base.recordId) || { game: base, list: [...base.expansions] };
        u.list.push(it.title);
        expUpdates.set(base.recordId, u);
        expansions.push({ title: it.title, base: base.title });
        continue;
      }
    }
    if (creates.length >= 8) { deferred.push(it.title); continue; }
    num += 1;
    const gameId = `photo-g${num}`;
    creates.push({ gameId, title: it.title, fields: newGameFields(it.title, gameId, num, { genre: it.genre, type: it.type, desc: it.desc }) });
  }
  const expRecords = [...expUpdates.entries()].map(([id, u]) => ({ id, fields: { [F.expansions]: JSON.stringify(u.list), [F.updatedAt]: new Date().toISOString() } }));
  return { creates, skipped, expansions, deferred, expRecords, ownedBgg: new Map(games.filter((g) => g.bggId).map((g) => [Number(g.bggId), g.title])) };
}

const IDENTIFY_INSTRUCTIONS = (owned: string[]) => [
  'Identify every board game box visible in this photo (fronts, backs or spines). Skip anything you cannot read confidently.',
  'Reply with JSON only:',
  '{"items": [{',
  '  "title": "official title as printed, e.g. \\"Dune: Imperium\\"",',
  '  "kind": "game" or "expansion",',
  '  "baseGame": "for an expansion, the title of the game it expands; else null",',
  '  "owned": "if this is the same game (any edition, spelling or language) as a title in the OWNED list below, that exact OWNED title; else null. An expansion is never the same game as its base game: for an expansion, only fill this if the expansion itself is in the list",',
  '  "genre": "theme/setting, 1-2 short labels joined by \\" / \\", e.g. \\"Nature / Ecology\\"",',
  '  "type": "core mechanics, 1-2 labels joined by \\" / \\", e.g. \\"Engine Building / Tableau\\"",',
  '  "desc": "one vivid sentence (max ~22 words) about what players do",',
  '  "confidence": 0.0-1.0',
  '}], "reason": "only if no boxes could be identified"}',
  'Style example: {"title":"Earth","kind":"game","genre":"Nature / Ecology","type":"Engine Building / Tableau","desc":"Construct an interconnected 4x4 flora and fauna island ecosystem with zero downtime on rival turns."}',
  '', 'OWNED:', ...owned,
].join('\n');

export function collectionRoutes(d: CollectionDeps) {
  const ai = () => { if (!d.openrouterKey) throw new ApiError(503, 'The AI service isn’t set up on this server yet'); return d.openrouterKey; };
  return new Hono<AuthEnv>()
    // POST /vault/add { bggId } | { title }: a game by name (a title alone: a game that isn't on BGG)
    .post('/add', async (c) => {
      ownerOnly(c);
      const b = await body(c);
      const bggId = Number(b.bggId) || null;
      const givenTitle = String(b.title || '').trim().slice(0, 200);
      if (!bggId && !givenTitle) throw new ApiError(400, 'Send a bggId, or a title for a game that is not on BGG');
      const email = c.get('auth').email;
      const games = (await listGames(d.db)).map(toGame);
      let thing: Thing | null = null;
      if (bggId) {
        thing = (await d.bgg.things([bggId]))[0] || null;
        if (!thing) throw new ApiError(404, 'BGG has no game #' + bggId);
      }
      const title = thing?.name || givenTitle;
      const key = normTitle(title);
      // Already owned: same BGG game, same title, or listed as an expansion
      const owned = (bggId && games.find((g) => Number(g.bggId) === bggId)) || games.find((g) => normTitle(g.title) === key);
      if (owned) throw new ApiError(409, `"${owned.title}" is already in your collection`);
      const listedIn = games.find((g) => g.expansions.some((e: string) => normTitle(e) === key));
      if (listedIn) throw new ApiError(409, `"${title}" is already listed as an expansion of ${listedIn.title}`);
      if (thing && thing.type === 'boardgameexpansion') {
        const baseIds = new Set(thing.baseIds);
        const base = games.find((g) => g.bggId && baseIds.has(Number(g.bggId))) || games.find((g) => thing!.bases.some((x) => normTitle(x.title) === normTitle(g.title)));
        if (base) {
          await patchGame(d.db, base.recordId, { [F.expansions]: JSON.stringify([...base.expansions, title]), [F.updatedAt]: new Date().toISOString() });
          return c.json({ ok: true, added: [], expansions: [{ title, base: base.title }], skipped: [] });
        }
      }
      const num = nextNum(games);
      const gameId = `name-g${num}`;
      const costs: AiCost[] = [];
      // Genre / type / one-liner in the collection's style, from BGG's description (skipped for games not on BGG)
      const blurb = thing && d.openrouterKey ? await writeBlurb(d.openrouterKey, d.fetch, title, thing) : null;
      if (blurb) costs.push(...blurb.cost);
      await createGames(d.db, [newGameFields(title, gameId, num, blurb || {})]);
      await logAi(d.db, email, costs);
      const username = await ownerBggUsername(d.db, d.config);
      const { enrich } = await finish(d, gameId, bggId, email, username);
      return c.json({ ok: true, added: [{ id: gameId, title }], expansions: [], skipped: [], title, ...(enrich?.newTitle ? { newTitle: enrich.newTitle } : {}) });
    })
    // POST /vault/identify (multipart { photo }): every box in the photo, classified before anything is written
    .post('/identify', async (c) => {
      ownerOnly(c);
      const key = ai();
      const photo = await photoIn(c);
      const email = c.get('auth').email;
      const games = (await listGames(d.db)).map(toGame);
      const costs: AiCost[] = [];
      let a;
      try {
        a = await ask(key, d.fetch, 'photo', { model: VISION_MODEL, max_tokens: 8000, reasoning: { effort: 'low' }, messages: [
          { role: 'system', content: 'You identify board games from photos for a personal collection catalog. Reply with JSON only.' },
          { role: 'user', content: [{ type: 'text', text: IDENTIFY_INSTRUCTIONS(games.map((g) => g.title).sort()) }, { type: 'image_url', image_url: { url: `data:${photo.mime};base64,${photo.b64}` } }] },
        ] });
      } catch { throw new ApiError(502, 'The photo couldn’t be read just now. Try again in a moment.'); }
      costs.push(a.cost);
      const { found, reason } = foundIn(a.text);
      if (!found.length) { await logAi(d.db, email, costs); throw new ApiError(422, 'Could not identify a game in that photo' + (reason ? ': ' + reason : '')); }
      const plan = planCollectionPhoto(found, games);
      if (plan.expRecords.length) await patchGames(d.db, plan.expRecords);
      const username = await ownerBggUsername(d.db, d.config);
      const kept: { id: string; title: string }[] = [], dupes: { title: string; reason: string; existing: string }[] = [];
      if (plan.creates.length) {
        const created = await createGames(d.db, plan.creates.map((x) => x.fields));
        for (const rec of created) {
          const id = String(rec.fields?.[F.gameId] || ''), title = String(rec.fields?.[F.title] || '');
          let bggId: number | null = null;
          try { bggId = (await enrichGame(d.db, d.bgg, { id, username })).bgg?.id ?? null; } catch (e) { warn('enrich', e); }
          // The same BGG game as one Dan owns (another edition, another spelling): take it back out
          if (bggId && plan.ownedBgg.has(bggId)) { dupes.push({ title, reason: 'same BGG game as one you own', existing: plan.ownedBgg.get(bggId)! }); await deleteGame(d.db, rec.id); continue; }
          if (bggId) plan.ownedBgg.set(bggId, title); // two different-looking boxes of the same game in one photo
          kept.push({ id, title });
        }
        for (const k of kept) { try { costs.push(...(await assignIcon(d.db, key, d.fetch, { id: k.id })).cost); } catch (e) { warn('icon', e); } }
      }
      await logAi(d.db, email, costs);
      return c.json({ ok: true, added: kept, skipped: [...plan.skipped, ...dupes], expansions: plan.expansions, deferred: plan.deferred, title: kept[0]?.title || null });
    });
}

async function finish(d: CollectionDeps, gameId: string, bggId: number | null, email: string, username: string | null) {
  const costs: AiCost[] = [];
  let enrich = null, icon = null;
  if (bggId) { try { enrich = await enrichGame(d.db, d.bgg, { id: gameId, bggId, username }); } catch (e) { warn('enrich', e); } }
  if (d.openrouterKey) { try { icon = await assignIcon(d.db, d.openrouterKey, d.fetch, { id: gameId }); costs.push(...icon.cost); } catch (e) { warn('icon', e); } }
  await logAi(d.db, email, costs);
  return { enrich, icon };
}
const warn = (where: string, e: unknown) => console.error(JSON.stringify({ level: 'warn', where, error: String((e as Error)?.message || e) }));
