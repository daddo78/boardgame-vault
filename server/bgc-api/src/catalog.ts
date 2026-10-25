// The polish a new catalog game gets after it lands on a shelf, any shelf: a genre, a type and a one-liner in the
// collection's style (from BGG's description), and a Tabler icon for the card when there is no box art. Only the blanks
// are filled (bgc.polish_game), so the shared catalog is never rewritten by a later add. What Dan's old Add Game By Name
// and Assign Icon workflows did for his collection alone.
import { ICON_MODEL, VISION_MODEL, ask, jsonIn, logAi, type AiCost } from './ai.js';
import type { Thing } from './bgg.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Fetch } from './http.js';

// Whose BGG plays the owner's shelf syncs from: BGG_USERNAME, else the admin's BGG username in the database (asked once)
let ownerName: string | null | undefined;
export async function ownerBggUsername(db: Db, config: Pick<Config, 'bggUsername'>): Promise<string | null> {
  if (config.bggUsername) return config.bggUsername;
  if (ownerName === undefined) ownerName = (await db.one<string>('SELECT bgg_username FROM members WHERE id = at.admin_id()', []).catch(() => null)) || null;
  return ownerName;
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

export type IconPick = { icon: string; match: string; candidates: string[]; cost: AiCost[] };
// A Tabler icon for a game's card: the model suggests 8, the first that exists (not an "-off" variant, not one overused
// elsewhere unless nothing else fits) wins; "meeple" is the fallback.
export async function pickIcon(key: string, f: Fetch, g: { title: string; genre: string; type: string; desc: string }, avoid: string[] = []): Promise<IconPick> {
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
  const raw = jsonIn(a.text).candidates;
  const candidates: string[] = (Array.isArray(raw) ? raw : []).map((c: unknown) => String(c).toLowerCase().trim().replace(/^ti-/, '').replace(/\s+/g, '-'));
  const avoidSet = new Set(avoid);
  let icon: string | null = null, match = 'fallback';
  for (const c of candidates) if (catalog.has(c) && !c.endsWith('-off') && !avoidSet.has(c)) { icon = c; match = 'exact'; break; }
  if (!icon) for (const c of candidates) if (catalog.has(c) && !c.endsWith('-off')) { icon = c; match = 'exact-avoided'; break; }
  if (!icon) for (const c of candidates) { const n = names.find((x) => x.startsWith(c + '-') && !x.endsWith('-off') && !x.endsWith('-filled')); if (n) { icon = n; match = 'prefix'; break; } }
  return { icon: icon || 'meeple', match, candidates, cost: [a.cost] };
}

export type Blurb = { genre: string; type: string; desc: string };
// Genre / type / one-liner in the collection's style, from BGG's description
export async function writeBlurb(key: string, f: Fetch, title: string, thing: Thing): Promise<Blurb & { cost: AiCost[] }> {
  const prompt = [
    `Board game: ${title}`, `BGG categories: ${thing.categories.join(', ')}`, `BGG mechanics: ${thing.mechanics.join(', ')}`, `BGG description: ${thing.descriptionLong}`, '',
    'Write catalog fields in this collection\'s style. Reply with JSON only:',
    '{"genre": "theme/setting, 1-2 short labels joined by \\" / \\"", "type": "core mechanics, 1-2 labels joined by \\" / \\"", "desc": "one vivid sentence (max ~22 words) about what players do"}',
    'Style example: {"genre":"Nature / Ecology","type":"Engine Building / Tableau","desc":"Construct an interconnected 4x4 flora and fauna island ecosystem with zero downtime on rival turns."}',
  ].join('\n');
  const a = await ask(key, f, 'other', { model: VISION_MODEL, max_tokens: 2000, reasoning: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] });
  const r = jsonIn(a.text);
  return { genre: String(r.genre || ''), type: String(r.type || ''), desc: String(r.desc || ''), cost: [a.cost] };
}

export type PolishDeps = { db: Db; openrouterKey?: string; fetch: Fetch };
type ToPolish = { ok: boolean; title?: string; genre?: string; type?: string; description?: string; icon?: string; bggId?: number | null; hasCover?: boolean; needsBlurb?: boolean; needsIcon?: boolean };

// After a game lands on a shelf (skey: its key there): the blurb if the catalog has none (from the vision model's own
// words for a photo add, else from BGG's description), and an icon if it has none. Never fails the add; costs are logged.
export async function polishGame(d: PolishDeps, email: string, skey: string, thing: Thing | null, given: Partial<Blurb> = {}): Promise<Record<string, string> | null> {
  const costs: AiCost[] = [];
  try {
    const g = await d.db.one<ToPolish>('SELECT bgc.game_to_polish($1, $2)', [email, skey]);
    if (!g?.ok) return null;
    const p: Record<string, string> = {};
    if (g.needsBlurb) {
      if (given.genre || given.desc) { p.genre = given.genre || ''; p.type = given.type || ''; p.desc = given.desc || ''; }
      else if (thing && d.openrouterKey) {
        try { const b = await writeBlurb(d.openrouterKey, d.fetch, g.title || thing.name, thing); costs.push(...b.cost); p.genre = b.genre; p.type = b.type; p.desc = b.desc; }
        catch (e) { warn('blurb', e); }
      }
    }
    if (g.needsIcon && d.openrouterKey) {
      try {
        const i = await pickIcon(d.openrouterKey, d.fetch, { title: g.title || '', genre: p.genre || g.genre || '', type: p.type || g.type || '', desc: p.desc || g.description || '' });
        costs.push(...i.cost); p.icon = i.icon;
      } catch (e) { warn('icon', e); }
    }
    if (!Object.keys(p).length) return null;
    const r = await d.db.one<Record<string, string>>('SELECT bgc.polish_game($1, $2, $3::jsonb)', [email, skey, JSON.stringify(p)]);
    return r || null;
  } catch (e) { warn('polish', e); return null; }
  finally { await logAi(d.db, email, costs); }
}
const warn = (where: string, e: unknown) => console.error(JSON.stringify({ level: 'warn', where, error: String((e as Error)?.message || e) }));
