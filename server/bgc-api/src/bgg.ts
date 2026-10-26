// BoardGameGeek's XML API2 and its image service, typed. What n8n's workflows did with HTTP nodes and the prelude's
// parseThingXml / parsePlays, in one place: searching, details, box art sizes, a user's plays (every page) and ratings.
// One request at a time per process, about a second apart, as BGG asks; a 202 ("ask again soon") or 429 is tried again.
import type { Fetch } from './http.js';

const API = 'https://boardgamegeek.com/xmlapi2/';
const IMAGES = 'https://api.geekdo.com/api/images/';

// BGG's XML attributes and text, with the entities put back
export const decode = (s: unknown): string => String(s ?? '').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Titles compared loosely: case, punctuation and a leading "the" don't count
export const normTitle = (s: unknown): string => String(s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/['’`]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').replace(/^the /, '').trim();
// A title as a BGG search query: letters, digits and spaces only
export const searchQuery = (title: string) => title.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();

export type Thing = {
  id: number; type: string; name: string; year: number | null; weight: number | null;
  minPlayers: number | null; maxPlayers: number | null; minTime: number | null; maxTime: number | null; minAge: number | null;
  rank: number | null; rating: number | null; usersRated: number; bestPlayers: number[];
  designers: string[]; categories: string[]; mechanics: string[]; baseIds: number[]; bases: { id: number; title: string }[];
  description: string | null;       // ~700 characters, for the catalog
  descriptionLong: string;          // ~1500 characters, for writing a blurb
  thumbnail: string | null; picId: string | null;
  coverCard?: string | null; coverLarge?: string | null;
};

const attr = (s: string, tag: string) => { const m = s.match(new RegExp('<' + tag + '\\s[^>]*value="([^"]*)"')); return m ? m[1] : null; };
const num = (v: string | null) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const links = (s: string, type: string) => [...s.matchAll(new RegExp('<link type="' + type + '" id="\\d+" value="([^"]*)"', 'g'))].map((m) => decode(m[1]));
// "Best with": player counts where Best is the top vote in BGG's suggested_numplayers poll
function bestWith(s: string): number[] {
  const poll = (s.match(/<poll name="suggested_numplayers"[\s\S]*?<\/poll>/) || [''])[0];
  const rows = [...poll.matchAll(/<results numplayers="(\d+)">([\s\S]*?)<\/results>/g)].map((m) => {
    const votes = (label: string) => Number((m[2].match(new RegExp('value="' + label + '" numvotes="(\\d+)"')) || [])[1] || 0);
    return { n: Number(m[1]), best: votes('Best'), rec: votes('Recommended'), not: votes('Not Recommended') };
  });
  const winners = rows.filter((r) => r.best > 0 && r.best >= r.rec && r.best >= r.not).map((r) => r.n);
  if (winners.length) return winners;
  const top = rows.filter((r) => r.best > 0).sort((a, b) => b.best - a.best)[0];
  return top ? [top.n] : [];
}

// The base games an expansion expands, with their names (from /thing)
const baseGamesOf = (s: string) => [...s.matchAll(/<link type="boardgameexpansion" id="(\d+)" value="([^"]*)" inbound="true"/g)].map((b) => ({ id: Number(b[1]), title: decode(b[2]) }));

// BGG's /thing XML (stats=1) -> plain objects, as the catalog keeps them (bgc.enrich_games reads this shape)
export function parseThingXml(xml: string | null | undefined): Thing[] {
  return [...String(xml || '').matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => {
    const s = m[3];
    const rank = (s.match(/<rank type="subtype"[^>]*name="boardgame"[^>]*value="(\d+)"/) || [])[1];
    const avg = Number(attr(s, 'average') || 0);
    const w = attr(s, 'averageweight');
    const rawDesc = (s.match(/<description>([\s\S]*?)<\/description>/) || ['', ''])[1];
    return {
      id: Number(m[2]), type: m[1], name: decode((s.match(/<name type="primary"[^>]*value="([^"]*)"/) || [])[1] || ''),
      year: num(attr(s, 'yearpublished')), weight: num(w) ? Math.round(Number(w) * 100) / 100 : null,
      minPlayers: num(attr(s, 'minplayers')), maxPlayers: num(attr(s, 'maxplayers')), minTime: num(attr(s, 'minplaytime')), maxTime: num(attr(s, 'maxplaytime')),
      minAge: num(attr(s, 'minage')), rank: rank ? Number(rank) : null, rating: avg > 0 ? Math.round(avg * 10) / 10 : null,
      usersRated: Number(attr(s, 'usersrated') || 0), bestPlayers: bestWith(s),
      designers: links(s, 'boardgamedesigner').filter((d) => d !== '(Uncredited)'), categories: links(s, 'boardgamecategory'), mechanics: links(s, 'boardgamemechanic'),
      // An expansion's inbound links point at the base game(s) it expands
      baseIds: [...s.matchAll(/<link type="boardgameexpansion" id="(\d+)"[^>]*inbound="true"/g)].map((x) => Number(x[1])),
      bases: baseGamesOf(s),
      description: decode(decode(rawDesc)).replace(/&#10;/g, ' ').replace(/&[a-z]+;|&#\d+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 700) || null,
      descriptionLong: decode(rawDesc).replace(/&#10;/g, '\n').replace(/\s+/g, ' ').trim().slice(0, 1500),
      thumbnail: (s.match(/<thumbnail>([^<]+)<\/thumbnail>/) || [])[1] || null,
      picId: (s.match(/<image>[^<]*\/pic(\d+)\.[a-z]+<\/image>/) || [])[1] || null,
    };
  });
}

export type SearchHit = { id: string; type: string; name: string; year: number | null };
// BGG's /search XML -> the hits (every name, primary or alternate, as BGG lists them)
export function parseSearchXml(xml: string | null | undefined): SearchHit[] {
  return [...String(xml || '').matchAll(/<item type="([^"]+)" id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => ({
    id: m[2], type: m[1], name: decode((m[3].match(/<name type="[^"]+" value="([^"]*)"/) || [])[1] || ''),
    year: Number((m[3].match(/<yearpublished value="(\d+)"/) || [])[1]) || null,
  }));
}

export type Play = { id: number; date: string; quantity: number; minutes: number; incomplete: boolean; location: string; bggId: number; gameName: string; comments: string;
  players: { seat: number; name: string; user: string; win: boolean; score: string; isNew: boolean; color: string; position: string; rating: string }[] };

// Pages of /plays -> plain play rows for at.save_plays (who played, won, how long). ok is false only when BGG answered with
// an error and no plays (an unknown username); the rows are always there, so a sync saves them either way
export function parsePlays(pages: string[]): { ok: boolean; message: string | null; plays: Play[] } {
  const a = (tag: string, k: string) => { const m = tag.match(new RegExp('\\b' + k + '="([^"]*)"')); return m ? decode(m[1]) : ''; };
  const plays: Play[] = [];
  for (const page of pages) {
    for (const p of String(page || '').match(/<play [\s\S]*?<\/play>/g) || []) {
      const head = p.match(/<play [^>]*>/)![0];
      const item = (p.match(/<item [^>]*>/) || [''])[0];
      plays.push({ id: Number(a(head, 'id')), date: a(head, 'date'), quantity: Number(a(head, 'quantity')) || 1,
        minutes: Number(a(head, 'length')) || 0, incomplete: a(head, 'incomplete') === '1', location: a(head, 'location'),
        bggId: Number(a(item, 'objectid')), gameName: a(item, 'name'), comments: decode((p.match(/<comments>([\s\S]*?)<\/comments>/) || ['', ''])[1]).trim(),
        players: (p.match(/<player [^>]*\/?>/g) || []).map((t, i) => ({ seat: i + 1, name: a(t, 'name') || a(t, 'username') || 'Anonymous',
          user: a(t, 'username'), win: a(t, 'win') === '1', score: a(t, 'score'), isNew: a(t, 'new') === '1',
          color: a(t, 'color'), position: a(t, 'startposition'), rating: a(t, 'rating') === '0' ? '' : a(t, 'rating') })) });
    }
  }
  const err = (String(pages[0] || '').match(/<error>\s*<message>([^<]*)<\/message>/) || [])[1];
  const bad = !!err && !plays.length;
  return { ok: !bad, message: bad ? err : null, plays: plays.filter((p) => p.id && p.bggId) };
}

export type GameTally = Record<string, { count: number; last: string | null }>;
// Plays per BGG game id: how many, and the latest date
export function tallyPlays(pages: string[]): { byGame: GameTally; total: number; gamesPlayed: number } {
  const byGame: GameTally = {};
  let total = 0;
  for (const xml of pages) {
    for (const m of String(xml || '').matchAll(/<play id="\d+" date="([^"]*)" quantity="(\d+)"[^>]*>[\s\S]*?<item [^>]*objectid="(\d+)"/g)) {
      const [, date, qty, objectId] = m;
      const g = (byGame[objectId] ??= { count: 0, last: null });
      g.count += Number(qty) || 1;
      total += Number(qty) || 1;
      if (date && date !== '0000-00-00' && (!g.last || date > g.last)) g.last = date;
    }
  }
  return { byGame, total, gamesPlayed: Object.keys(byGame).length };
}

export type Person = { name: string; total: number; games: Record<string, { plays: number; wins: number; last: string | null }> };
// Who played what, from the plays' player lists: lowercased name -> their history per BGG game id
export function tallyPeople(pages: string[]): Record<string, Person> {
  const people: Record<string, Person> = {};
  for (const xml of pages) {
    for (const m of String(xml || '').matchAll(/<play id="\d+" date="([^"]*)" quantity="(\d+)"[^>]*>([\s\S]*?)<\/play>/g)) {
      const [, date, qty, inner] = m;
      const bggId = (inner.match(/objectid="(\d+)"/) || [])[1];
      if (!bggId) continue;
      for (const pm of inner.matchAll(/<player ([^>]*)\/>/g)) {
        const a = Object.fromEntries([...pm[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], decode(x[2])]));
        const name = (a.name || a.username || '').trim();
        if (!name || /^anonymous/i.test(name)) continue;
        const p = (people[name.toLowerCase()] ??= { name, total: 0, games: {} });
        const g = (p.games[bggId] ??= { plays: 0, wins: 0, last: null });
        const n = Number(qty) || 1;
        g.plays += n; p.total += n;
        if (a.win === '1') g.wins += n;
        if (date && date !== '0000-00-00' && (!g.last || date > g.last)) g.last = date;
      }
    }
  }
  return people;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Bgg {
  private lastAt = 0;
  private lastImageAt = 0;
  // gapMs: the least time between two BGG requests from this process (tests set 0)
  constructor(private f: Fetch, private token: string | undefined, public gapMs = 1000) {}

  get ready() { return !!this.token; }

  // The text of one BGG answer, or null when it can't answer. 202/429 and 5xx: one more try after 2 s.
  async text(path: string, params: Record<string, string>): Promise<string | null> {
    if (!this.token) return null;
    const url = API + path + '?' + new URLSearchParams(params);
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(2000);
      const wait = this.lastAt + this.gapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastAt = Date.now();
      try {
        const r = await this.f(url, { headers: { Authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(30_000) });
        if (r.ok && r.status !== 202) return await r.text();
        if (r.status < 500 && r.status !== 202 && r.status !== 429) return null; // a 4xx that won't change
      } catch { /* try again */ }
    }
    return null;
  }

  search(query: string, types = 'boardgame,boardgameexpansion') { return this.text('search', { query, type: types }); }
  async things(ids: (string | number)[]): Promise<Thing[]> {
    const list = ids.map(String).filter((x) => /^\d+$/.test(x));
    if (!list.length) return [];
    return parseThingXml(await this.text('thing', { id: list.join(','), stats: '1' }));
  }

  // The sizes BGG's own site uses (the XML gives only a 200x150 thumbnail and the huge original). No key needed.
  async imageSizes(picId: string | number | null | undefined): Promise<{ coverCard: string | null; coverLarge: string | null }> {
    if (!picId) return { coverCard: null, coverLarge: null };
    const wait = this.lastImageAt + 250 - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastImageAt = Date.now();
    try {
      const r = await this.f(IMAGES + picId, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) return { coverCard: null, coverLarge: null };
      const im = ((await r.json()) as any).images || {};
      return { coverCard: im.medium?.url || im.itempage?.url || null, coverLarge: im.itempage?.url || im.medium?.url || null };
    } catch { return { coverCard: null, coverLarge: null }; }
  }
  async withCover(t: Thing): Promise<Thing> { return { ...t, ...(await this.imageSizes(t.picId)) }; }

  // Every page of a user's logged plays (BG Stats posts there); id: only this game's; from/to: only those days
  // (yyyy-mm-dd). Pages arrive 2 s apart, 100 at most.
  async plays(username: string, opts: { id?: number; from?: string; to?: string; maxPages?: number } = {}): Promise<string[]> {
    const pages: string[] = [];
    for (let page = 1; page <= (opts.maxPages ?? 100); page++) {
      if (page > 1) await sleep(Math.max(0, 2000 - this.gapMs));
      const xml = await this.text('plays', { username, type: 'thing', subtype: 'boardgame', page: String(page), ...(opts.id ? { id: String(opts.id) } : {}),
        ...(opts.from ? { mindate: opts.from } : {}), ...(opts.to ? { maxdate: opts.to } : {}) });
      if (xml == null) { if (!pages.length) pages.push(''); break; }
      pages.push(xml);
      if (!xml.includes('<play ')) break;
    }
    return pages;
  }

  // A user's BGG ratings from their collection (out of 10). BGG prepares a collection in the background: 202 means wait.
  async collectionRatings(username: string): Promise<{ ok: boolean; ratings: { bggId: number; rating10: number }[] }> {
    if (!this.token) return { ok: false, ratings: [] };
    const url = API + 'collection?' + new URLSearchParams({ username, rated: '1', stats: '1', subtype: 'boardgame' });
    let xml = '';
    for (const wait of [0, 8000, 20000]) {
      if (wait) await sleep(wait);
      try {
        const r = await this.f(url, { headers: { Authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(30_000) });
        const body = await r.text();
        if (r.status === 200 && body.includes('<items')) { xml = body; break; }
      } catch { /* try again */ }
    }
    const ratings = [...xml.matchAll(/<item objecttype="thing" objectid="(\d+)"[\s\S]*?<rating value="([\d.]+)"/g)]
      .map((m) => ({ bggId: Number(m[1]), rating10: Number(m[2]) })).filter((r) => r.rating10 > 0);
    return { ok: xml.includes('<items'), ratings };
  }

  // One game in a user's collection, for writing it back with only our change (bggAccount.ts parseCollectionItem).
  // Base games, then expansions (BGG lists them apart). null: BGG couldn't answer; '' would mean not in the collection.
  async collectionItemXml(username: string, bggId: number): Promise<string | null> {
    if (!this.token) return null;
    let all = '';
    for (const subtype of ['boardgame', 'boardgameexpansion']) {
      const url = API + 'collection?' + new URLSearchParams({ username, id: String(bggId), stats: '1', subtype, ...(subtype === 'boardgame' ? { excludesubtype: 'boardgameexpansion' } : {}) });
      let xml: string | null = null;
      for (const wait of [0, 5000, 15000]) {
        if (wait) await sleep(wait);
        const gap = this.lastAt + this.gapMs - Date.now();
        if (gap > 0) await sleep(gap);
        this.lastAt = Date.now();
        try {
          const r = await this.f(url, { headers: { Authorization: 'Bearer ' + this.token }, signal: AbortSignal.timeout(30_000) });
          const body = await r.text();
          if (r.status === 200 && body.includes('<items')) { xml = body; break; }
          if (r.status !== 202 && r.status !== 429 && r.status < 500) return null;
        } catch { /* try again */ }
      }
      if (xml == null) return null;
      if (xml.includes('objectid="' + bggId + '"')) return xml;
      all += xml;
    }
    return all;
  }

  // A title -> the BGG game it most likely means: exact title matches (or, when allowed, "Anno 1800" ~ "Anno 1800: The
  // Board Game"), the right kind first, then the one most people rated. null when BGG has nothing or can't answer.
  async findByTitle(title: string, opts: { year?: number | null; fuzzy?: boolean; want?: 'boardgame' | 'boardgameexpansion'; types?: string } = {}): Promise<Thing | null> {
    const xml = await this.search(searchQuery(title), opts.types);
    if (xml == null) return null;
    const t = normTitle(title);
    const items = parseSearchXml(xml);
    let pool = items.filter((i) => normTitle(i.name) === t);
    if (opts.year && pool.some((i) => i.year === opts.year)) pool = pool.filter((i) => i.year === opts.year);
    if (!pool.length && opts.fuzzy) pool = items.filter((i) => { const n = normTitle(i.name); return n && (n.startsWith(t + ' ') || t.startsWith(n + ' ')); });
    const ids = [...new Set(pool.map((i) => i.id))].slice(0, 20);
    if (!ids.length) return null;
    const want = opts.want || 'boardgame';
    const things = (await this.things(ids)).sort((a, b) => ((b.type === want ? 1 : 0) - (a.type === want ? 1 : 0)) || (b.usersRated - a.usersRated));
    return things[0] || null;
  }
}
