// Writing to a member's own BoardGameGeek account: what BG Stats and BGG's Android app do, since BGG has no write API.
// The XML API (bgg.ts) only reads. Here, the member signs in once with their BGG password; BGG answers with a session
// token (its "bggpassword" cookie, which is not the password) that we keep, encrypted, and the password is forgotten.
// Every write then sends that token as the cookie BGG's own site sends:
//   POST /login/api/v1        { credentials: { username, password } }  -> Set-Cookie bggpassword=<token>; expires=...
//   POST /geekplay.php        a play (form fields as BGG's play form; players[i][...]) -> { playid, numplays } or { error }
//   POST /geekcollection.php  additem, savedata fieldname=status (every status flag at once), fieldname=rating, delete
// Field names are the ones in BGG's open-source Android app (ccomeaux/boardgamegeek4android, PlayMapper.kt and
// CollectionItemMapper.kt). Requests go one at a time per process, two seconds apart, as BGG asks of scripts.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Fetch } from './http.js';

const SITE = 'https://boardgamegeek.com';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The session token at rest: AES-256-GCM with BGG_LINK_KEY (32 bytes as 64 hex characters, in Infisical), as
// "v1.<iv>.<tag>.<ciphertext>" in base64url. Without the key nobody can link BGG, and stored tokens can't be read.
export function sealToken(key: Buffer, token: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(token, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}
export function openToken(key: Buffer, sealed: string): string | null {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || body == null) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}
export const linkKey = (hex: string | undefined): Buffer | null => (hex && /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null);

export type Session = { username: string; token: string };
export type LoginResult = { ok: true; token: string; expires: string | null } | { ok: false; reason: 'password' | 'unavailable' };

// What a write came back with. auth: BGG no longer takes the token (signed out, password changed), so the member signs in
// again; gone: the play or item isn't there any more; error: anything else, worth trying again later.
export type WriteResult = { ok: true; playId?: number } | { ok: false; kind: 'auth' | 'gone' | 'error'; message: string };

// Every status flag BGG keeps on a collection item; a status save sends them all, so the ones we don't change go back as they were
export type Status = { own: boolean; prevowned: boolean; fortrade: boolean; want: boolean; wanttoplay: boolean; wanttobuy: boolean;
  wishlist: boolean; wishlistpriority: number; preordered: boolean };
export const NO_STATUS: Status = { own: false, prevowned: false, fortrade: false, want: false, wanttoplay: false, wanttobuy: false,
  wishlist: false, wishlistpriority: 3, preordered: false };

export type PlayOut = { bggId: number; date: string; minutes: number | null; quantity: number; location: string; comments: string;
  players: { name: string; username: string; win: boolean; score: string; isNew: boolean; color?: string; position?: string; rating?: string }[] };

// BGG's answers for a session that is no longer good (the play form's and the collection utilities' wording)
const AUTH_ERRORS = /must login|must <a href="\/login">login|not permitted|can't delete this play|login required/i;
const GONE_ERRORS = /play does not exist|invalid item/i;

export class BggAccount {
  private lastAt = 0;
  // gapMs: the least time between two writes from this process (tests set 0)
  constructor(private f: Fetch, public gapMs = 2000) {}

  private async post(path: string, body: string, headers: Record<string, string>): Promise<Response> {
    const wait = this.lastAt + this.gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastAt = Date.now();
    return this.f(SITE + path, { method: 'POST', body, headers: { 'User-Agent': 'BoardGameCurator/1.0 (+https://bg.ondorilabo.com)', ...headers },
      redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  }

  // Signs in once. The password goes to BGG and nowhere else: not logged, not stored, not returned.
  async login(username: string, password: string): Promise<LoginResult> {
    let r: Response;
    try { r = await this.post('/login/api/v1', JSON.stringify({ credentials: { username, password } }), { 'Content-Type': 'application/json' }); }
    catch { return { ok: false, reason: 'unavailable' }; }
    if (r.status >= 500 || r.status === 429) return { ok: false, reason: 'unavailable' };
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.match(/^bggpassword=([^;]*)(.*)$/i)).find((m) => m && m[1] && m[1] !== 'deleted');
    if (!r.ok || !cookie) return { ok: false, reason: 'password' };
    const exp = cookie[2].match(/;\s*expires=([^;]+)/i);
    const when = exp ? new Date(exp[1]) : null;
    return { ok: true, token: decodeURIComponent(cookie[1]), expires: when && !isNaN(+when) ? when.toISOString() : null };
  }

  private async form(s: Session, path: string, fields: [string, string][], referer: string): Promise<{ status: number; json: any; text: string } | null> {
    try {
      const r = await this.post(path, new URLSearchParams(fields).toString(), {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: 'bggusername=' + encodeURIComponent(s.username) + '; bggpassword=' + encodeURIComponent(s.token),
        Referer: SITE + referer, 'X-Requested-With': 'XMLHttpRequest',
      });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* the collection utilities sometimes answer with HTML */ }
      return { status: r.status, json, text };
    } catch { return null; }
  }

  private static outcome(a: { status: number; json: any; text: string } | null): WriteResult {
    if (!a) return { ok: false, kind: 'error', message: 'BGG could not be reached' };
    const err = typeof a.json?.error === 'string' ? a.json.error : (a.json ? '' : a.text.match(AUTH_ERRORS)?.[0] ?? '');
    if (a.status === 401 || a.status === 403 || (a.status >= 300 && a.status < 400) || AUTH_ERRORS.test(err)) return { ok: false, kind: 'auth', message: err || 'BGG wants you to sign in again' };
    if (GONE_ERRORS.test(err)) return { ok: false, kind: 'gone', message: err };
    if (a.status >= 400 || err) return { ok: false, kind: 'error', message: err || 'BGG answered ' + a.status };
    return { ok: true };
  }

  // A new play (no playId) or a change to one already on BGG
  async savePlay(s: Session, p: PlayOut, playId?: number): Promise<WriteResult> {
    const f: [string, string][] = [['ajax', '1'], ['action', 'save'], ['version', '2'], ['objecttype', 'thing']];
    if (playId) f.push(['playid', String(playId)]);
    f.push(['objectid', String(p.bggId)], ['playdate', p.date], ['dateinput', p.date], ['length', p.minutes ? String(p.minutes) : ''],
      ['location', p.location], ['quantity', String(p.quantity || 1)], ['incomplete', '0'], ['nowinstats', '0'], ['comments', p.comments]);
    p.players.forEach((pl, i) => {
      const k = (x: string) => 'players[' + i + '][' + x + ']';
      f.push([k('playerid'), 'player_' + i], [k('name'), pl.name], [k('username'), pl.username], [k('color'), pl.color || ''], [k('position'), pl.position || ''],
        [k('score'), pl.score], [k('rating'), pl.rating || '0'], [k('new'), pl.isNew ? '1' : '0'], [k('win'), pl.win ? '1' : '0']);
    });
    const a = await this.form(s, '/geekplay.php', f, '/boardgame/' + p.bggId);
    const out = BggAccount.outcome(a);
    if (!out.ok) return out;
    const id = Number(a!.json?.playid);
    return id > 0 ? { ok: true, playId: id } : (playId ? { ok: true, playId } : { ok: false, kind: 'error', message: 'BGG did not say which play it saved' });
  }

  async deletePlay(s: Session, playId: number): Promise<WriteResult> {
    return BggAccount.outcome(await this.form(s, '/geekplay.php', [['ajax', '1'], ['action', 'delete'], ['playid', String(playId)], ['finalize', '1']], '/plays'));
  }

  private collection(s: Session, bggId: number, collId: number | null, rest: [string, string][]) {
    const f: [string, string][] = [['ajax', '1'], ['objecttype', 'thing'], ['objectid', String(bggId)]];
    if (collId) f.push(['collid', String(collId)]);
    return this.form(s, '/geekcollection.php', [...f, ...rest], '/boardgame/' + bggId);
  }

  // Puts the game in the member's BGG collection (no flags yet); BGG ignores it for a game already there
  async addItem(s: Session, bggId: number): Promise<WriteResult> {
    return BggAccount.outcome(await this.collection(s, bggId, null, [['action', 'additem']]));
  }

  async saveStatus(s: Session, bggId: number, collId: number | null, st: Status): Promise<WriteResult> {
    const b = (x: boolean) => (x ? '1' : '0');
    return BggAccount.outcome(await this.collection(s, bggId, collId, [['action', 'savedata'], ['fieldname', 'status'],
      ['own', b(st.own)], ['prevowned', b(st.prevowned)], ['fortrade', b(st.fortrade)], ['want', b(st.want)], ['wanttobuy', b(st.wanttobuy)],
      ['wanttoplay', b(st.wanttoplay)], ['preordered', b(st.preordered)], ['wishlist', b(st.wishlist)], ['wishlistpriority', String(st.wishlistpriority || 3)]]));
  }

  // rating10: 1-10 in halves (a member's stars x 2), or null to clear it
  async saveRating(s: Session, bggId: number, collId: number | null, rating10: number | null): Promise<WriteResult> {
    return BggAccount.outcome(await this.collection(s, bggId, collId, [['action', 'savedata'], ['fieldname', 'rating'], ['rating', rating10 ? String(rating10) : '']]));
  }
}

// One game in a user's collection XML (/xmlapi2/collection?username=&id=), for what to send back unchanged.
// null: not in their collection.
export function parseCollectionItem(xml: string, bggId: number): { collId: number; status: Status; rating10: number | null } | null {
  const m = xml.match(new RegExp('<item objecttype="thing" objectid="' + bggId + '"[^>]*collid="(\\d+)"[^>]*>([\\s\\S]*?)</item>'));
  if (!m) return null;
  const st = m[2].match(/<status ([^>]*)\/?>/)?.[1] ?? '';
  const flag = (k: string) => new RegExp('\\b' + k + '="1"').test(st);
  const pri = Number(st.match(/wishlistpriority="(\d)"/)?.[1]);
  const r = Number(m[2].match(/<rating value="([\d.]+)"/)?.[1]);
  return {
    collId: Number(m[1]),
    status: { own: flag('own'), prevowned: flag('prevowned'), fortrade: flag('fortrade'), want: flag('want'), wanttoplay: flag('wanttoplay'),
      wanttobuy: flag('wanttobuy'), wishlist: flag('wishlist'), wishlistpriority: pri >= 1 && pri <= 5 ? pri : 3, preordered: flag('preordered') },
    rating10: r > 0 ? r : null,
  };
}
