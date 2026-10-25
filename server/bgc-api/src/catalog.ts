// Dan's own collection, through the Airtable-compatible adapter (at.request, schema/002): list, create, change and
// remove his games, and the two steps a new game gets: BGG details and box art (the old BGG Enrich workflow) and a
// Tabler icon picked by a model (Assign Icon). Members' shelves don't come through here: bgc.shelf_add does their work.
import { ICON_MODEL, VISION_MODEL, ask, jsonIn, logAi, type AiCost } from './ai.js';
import { atRequest } from './at.js';
import { Bgg, normTitle, parseSearchXml, type Thing } from './bgg.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { F, GAMES_TABLE, type AtRecord } from './fields.js';
import type { Fetch } from './http.js';
import { toGame } from './shape.gen.js';

export type Game = ReturnType<typeof toGame>;

const req = (db: Db, method: string, path: string, body: unknown, formula = '') => atRequest(db, GAMES_TABLE, method, path, body, formula);

// Whose BGG plays count for Dan's shelf: BGG_USERNAME, else the admin's BGG username in the database (asked once)
let ownerName: string | null | undefined;
export async function ownerBggUsername(db: Db, config: Pick<Config, 'bggUsername'>): Promise<string | null> {
  if (config.bggUsername) return config.bggUsername;
  if (ownerName === undefined) ownerName = (await db.one<string>('SELECT bgg_username FROM members WHERE id = at.admin_id()', []).catch(() => null)) || null;
  return ownerName;
}

export async function listGames(db: Db): Promise<AtRecord[]> {
  const r = await req(db, 'GET', '', null);
  return Array.isArray(r?.records) ? r.records : [];
}
// One of Dan's games by its id (a record id or the page's GameID), or null
export async function findGame(db: Db, id: string): Promise<AtRecord | null> {
  const formula = /^rec[A-Za-z0-9]{14}$/.test(id) ? `RECORD_ID()='${id}'` : `{GameID}='${String(id).replace(/'/g, "\\'")}'`;
  const r = await req(db, 'GET', '', null, formula);
  return r?.records?.[0] || null;
}
export async function createGames(db: Db, fields: Record<string, unknown>[]): Promise<AtRecord[]> {
  if (!fields.length) return [];
  const r = await req(db, 'POST', '', { records: fields.map((f) => ({ fields: f })), typecast: true, returnFieldsByFieldId: true });
  return Array.isArray(r?.records) ? r.records : [];
}
export async function patchGame(db: Db, recordId: string, fields: Record<string, unknown>): Promise<void> {
  await req(db, 'PATCH', '/' + recordId, { fields, typecast: true, returnFieldsByFieldId: true });
}
export async function patchGames(db: Db, records: { id: string; fields: Record<string, unknown> }[]): Promise<void> {
  for (let i = 0; i < records.length; i += 10) await req(db, 'PATCH', '', { records: records.slice(i, i + 10), typecast: true });
}
export async function deleteGame(db: Db, recordId: string): Promise<void> {
  await req(db, 'DELETE', '/' + recordId, null);
}

// The fields a brand-new game starts with (the page's id is "<prefix>-g<N>"; N is the next number on the shelf)
export function newGameFields(title: string, gameId: string, num: number, extra: Partial<Record<'genre' | 'type' | 'desc', string>> = {}) {
  const now = new Date().toISOString();
  return { [F.title]: title, [F.gameId]: gameId, [F.num]: num, [F.genre]: extra.genre || '', [F.type]: extra.type || '', [F.desc]: extra.desc || '',
    [F.expansions]: '[]', [F.desireToPlay]: 0, [F.thinningCandidate]: false, [F.icon]: 'meeple', [F.addedAt]: now, [F.updatedAt]: now };
}
export const nextNum = (games: Game[]) => Math.max(0, ...games.map((g) => Number(g.num) || 0)) + 1;

export type EnrichOpts = { id: string; bggId?: number | null; rematch?: boolean; adoptTitle?: boolean; applyFuzzy?: boolean; dryRun?: boolean;
  username?: string | null }; // whose BGG plays count for the game (Dan's)
export type EnrichResult = { ok: true; id: string; title: string; matchType: string; applied: boolean; dryRun: boolean;
  bgg: (Partial<Thing> & { playCount?: number; lastPlayed?: string | null }) | null; newTitle: string | null; alternatives: { id: number; title: string; year: number | null; usersRated: number }[] };

// BGG details, box art and plays for one of Dan's games. A game that already has a BGGId reuses it (rematch searches
// again; bggId pins one). Otherwise BGG is searched and an exact title match accepted, ranked by how many rated it, so
// the main game wins over a same-named obscure one. Titles belong to the collection: BGG never renames a game, and with
// adoptTitle only cosmetically ("Scout" -> "SCOUT"). Loose matches are saved only with applyFuzzy.
export async function enrichGame(db: Db, bgg: Bgg, o: EnrichOpts): Promise<EnrichResult> {
  const rec = await findGame(db, o.id);
  if (!rec) throw new Error('Game not found: ' + o.id);
  const game = toGame(rec);
  const fixedId = (Number(o.bggId) || null) || (!o.rematch && game.bggId ? Number(game.bggId) : null);
  const base = { id: game.id, title: game.title, dryRun: !!o.dryRun };
  let matchType = fixedId ? (o.bggId ? 'manual' : 'stored') : 'exact';
  let ids: string[] = fixedId ? [String(fixedId)] : [];
  if (!fixedId) {
    const xml = await bgg.search(game.title.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(), 'boardgame');
    const items = parseSearchXml(xml);
    const t = normTitle(game.title);
    let pool = items.filter((i) => normTitle(i.name) === t);
    if (!pool.length) { matchType = 'fuzzy'; pool = items.filter((i) => { const n = normTitle(i.name); return n && (n.startsWith(t + ' ') || t.startsWith(n + ' ')); }); }
    ids = [...new Set(pool.map((i) => i.id))].slice(0, 20);
    if (!ids.length) return { ...base, matchType: 'none', applied: false, bgg: null, newTitle: null, alternatives: [], ok: true };
  }
  const things = (await bgg.things(ids)).sort((a, b) => ((b.type === 'boardgame' ? 1 : 0) - (a.type === 'boardgame' ? 1 : 0)) || (b.usersRated - a.usersRated));
  const best = things[0];
  if (!best) return { ...base, matchType: 'none', applied: false, bgg: null, newTitle: null, alternatives: [], ok: true };
  const fields: Record<string, unknown> = {
    [F.bggId]: best.id, [F.bggRating]: best.rating,
    [F.minPlayers]: best.minPlayers, [F.maxPlayers]: best.maxPlayers, [F.bestPlayers]: JSON.stringify(best.bestPlayers),
    [F.minTime]: best.minTime, [F.maxTime]: best.maxTime, [F.minAge]: best.minAge,
    [F.weight]: best.weight, [F.year]: best.year, [F.rank]: best.rank,
    [F.designers]: JSON.stringify(best.designers), [F.categories]: JSON.stringify(best.categories), [F.mechanics]: JSON.stringify(best.mechanics),
    [F.updatedAt]: new Date().toISOString(),
  };
  const trusted = matchType === 'exact' || matchType === 'manual';
  const retitle = !!o.adoptTitle && !!best.name && best.name !== game.title && normTitle(best.name) === normTitle(game.title);
  if (retitle) fields[F.title] = best.name;
  const apply = !o.dryRun && (trusted || matchType === 'stored' || !!o.applyFuzzy);
  // Box art (a failure here just means no cover) and this game's plays, so a new game shows them right away
  const cover = await bgg.imageSizes(best.picId);
  if (cover.coverCard) { fields[F.coverCard] = cover.coverCard; fields[F.coverLarge] = cover.coverLarge; }
  let playCount: number | undefined, lastPlayed: string | null | undefined;
  if (o.username) {
    const [xml] = await bgg.plays(o.username, { id: best.id, maxPages: 1 });
    if (xml && xml.includes('<plays')) {
      let count = 0, last: string | null = null;
      for (const p of xml.matchAll(/<play id="\d+" date="([^"]*)" quantity="(\d+)"/g)) {
        count += Number(p[2]) || 1;
        if (p[1] && p[1] !== '0000-00-00' && (!last || p[1] > last)) last = p[1];
      }
      const total = Number((xml.match(/<plays [^>]*total="(\d+)"/) || [])[1] || 0);
      if (total > 100) count = Math.max(count, total); // a page holds 100 plays; the nightly sync sums them exactly
      fields[F.playCount] = count; fields[F.lastPlayed] = last;
      playCount = count; lastPlayed = last;
    }
  }
  if (apply) await patchGame(db, rec.id, fields);
  const { designers, categories, mechanics, descriptionLong, description, ...summary } = best;
  return { ...base, ok: true, matchType, applied: apply, bgg: { ...summary, designers, coverCard: cover.coverCard, ...(playCount !== undefined ? { playCount, lastPlayed } : {}) },
    newTitle: retitle ? best.name : null, alternatives: things.slice(1, 4).map((t) => ({ id: t.id, title: t.name, year: t.year, usersRated: t.usersRated })) };
}

const TABLER_CSS = 'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.49.0/dist/tabler-icons.min.css';
let tabler: { names: string[]; at: number } | null = null;
// Every icon name in the exact stylesheet the page loads, so a saved icon always renders. Kept for a day.
export async function tablerNames(f: Fetch): Promise<string[]> {
  if (tabler && Date.now() - tabler.at < 86_400_000) return tabler.names;
  const r = await f(TABLER_CSS, { signal: AbortSignal.timeout(30_000) });
  const names = [...(await r.text()).matchAll(/\.ti-([a-z0-9-]+):before/g)].map((m) => m[1]);
  if (names.length < 1000) throw new Error('Tabler catalog looks wrong: only ' + names.length + ' icons');
  tabler = { names, at: Date.now() };
  return names;
}

export type IconResult = { ok: true; id: string; title: string; icon: string; match: string; candidates: string[]; cost: AiCost[] };
// A Tabler icon for a game's card: the model suggests 8, the first that exists (not an "-off" variant, not one overused
// elsewhere unless nothing else fits) is saved; "meeple" is the fallback.
export async function assignIcon(db: Db, key: string, f: Fetch, o: { id: string; avoid?: string[] }): Promise<IconResult> {
  const rec = await findGame(db, o.id);
  if (!rec) throw new Error('Game not found: ' + o.id);
  const g = toGame(rec);
  const avoid = (o.avoid || []).map(String);
  const names = await tablerNames(f);
  const prompt = [
    `Board game: ${g.title}`, `Theme/genre: ${g.genre}`, `Mechanics: ${g.type}`, `Description: ${g.desc}`, '',
    'Suggest 8 Tabler Icons (v3) names for a small pictogram on this game\'s collection card, best first.',
    '- Use exact Tabler names: kebab-case, as in class "ti ti-<name>", without the "ti-" prefix.',
    '- Depict what is most distinctive about this particular game (a signature object, creature, place or action), not its broad genre or its mechanics.',
    '- Avoid generic gaming icons (meeple, dice, cards, chess, puzzle, device-gamepad) unless the game is literally about them.',
    '- Never use "-off" variants.',
    ...(avoid.length ? [`- These icons are already used by many other games in the collection; do not suggest them: ${avoid.join(', ')}.`] : []),
    'Reply with JSON only: {"candidates":["name1","name2",...]}',
  ].join('\n');
  const a = await ask(key, f, 'other', { model: ICON_MODEL, max_tokens: 1000, temperature: 0.2, reasoning: { enabled: false },
    messages: [{ role: 'system', content: 'You pick pictograms from the Tabler Icons library for a board game collection app. Reply with JSON only.' }, { role: 'user', content: prompt }] });
  const catalog = new Set(names);
  const candidates: string[] = (Array.isArray(jsonIn(a.text).candidates) ? jsonIn(a.text).candidates : []).map((c: unknown) => String(c).toLowerCase().trim().replace(/^ti-/, '').replace(/\s+/g, '-'));
  const avoidSet = new Set(avoid);
  let icon: string | null = null, match = 'fallback';
  for (const c of candidates) if (catalog.has(c) && !c.endsWith('-off') && !avoidSet.has(c)) { icon = c; match = 'exact'; break; }
  if (!icon) for (const c of candidates) if (catalog.has(c) && !c.endsWith('-off')) { icon = c; match = 'exact-avoided'; break; }
  if (!icon) for (const c of candidates) { const n = names.find((x) => x.startsWith(c + '-') && !x.endsWith('-off') && !x.endsWith('-filled')); if (n) { icon = n; match = 'prefix'; break; } }
  if (!icon) icon = 'meeple';
  await patchGame(db, rec.id, { [F.icon]: icon, [F.updatedAt]: new Date().toISOString() });
  return { ok: true, id: g.id, title: g.title, icon, match, candidates, cost: [a.cost] };
}

// Genre / type / one-liner in the collection's style, from BGG's description (nothing for a game not on BGG)
export async function writeBlurb(key: string, f: Fetch, title: string, thing: Thing): Promise<{ genre: string; type: string; desc: string; cost: AiCost[] }> {
  const prompt = [
    `Board game: ${title}`, `BGG categories: ${thing.categories.join(', ')}`, `BGG mechanics: ${thing.mechanics.join(', ')}`, `BGG description: ${thing.descriptionLong}`, '',
    'Write catalog fields in this collection\'s style. Reply with JSON only:',
    '{"genre": "theme/setting, 1-2 short labels joined by \\" / \\"", "type": "core mechanics, 1-2 labels joined by \\" / \\"", "desc": "one vivid sentence (max ~22 words) about what players do"}',
    'Style example: {"genre":"Nature / Ecology","type":"Engine Building / Tableau","desc":"Construct an interconnected 4x4 flora and fauna island ecosystem with zero downtime on rival turns."}',
  ].join('\n');
  try {
    const a = await ask(key, f, 'other', { model: VISION_MODEL, max_tokens: 2000, reasoning: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] });
    const r = jsonIn(a.text);
    return { genre: String(r.genre || ''), type: String(r.type || ''), desc: String(r.desc || ''), cost: [a.cost] };
  } catch { return { genre: '', type: '', desc: '', cost: [] }; } // a blurb is a nicety; the game is still added
}

// Everything the catalog work needs, handed in once
export type CatalogDeps = { db: Db; bgg: Bgg; openrouterKey?: string; fetch: Fetch; username?: string | null };

// The two steps a new game on Dan's shelf gets, in order; neither failing stops the other. Costs are logged.
export async function finishNewGame(d: CatalogDeps, gameId: string, bggId: number | null, email: string): Promise<{ enrich: EnrichResult | null; icon: IconResult | null }> {
  let enrich: EnrichResult | null = null, icon: IconResult | null = null;
  const costs: AiCost[] = [];
  if (bggId) { try { enrich = await enrichGame(d.db, d.bgg, { id: gameId, bggId, username: d.username }); } catch (e) { warn('enrich', e); } }
  if (d.openrouterKey) { try { icon = await assignIcon(d.db, d.openrouterKey, d.fetch, { id: gameId }); costs.push(...icon.cost); } catch (e) { warn('icon', e); } }
  await logAi(d.db, email, costs);
  return { enrich, icon };
}
const warn = (where: string, e: unknown) => console.error(JSON.stringify({ level: 'warn', where, error: String((e as Error)?.message || e) }));
