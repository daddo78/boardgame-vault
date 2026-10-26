// Writing to a member's BGG account: the token kept sealed, signing in, and the forms BGG's own app sends
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BggAccount, linkKey, NO_STATUS, openToken, parseCollectionItem, sealToken } from '../src/bggAccount.js';

const KEY = linkKey('11'.repeat(32))!;
const S = { username: 'nathan_bgc', token: 'tok%en' };

// A stand-in for boardgamegeek.com that remembers what was sent and answers with whatever the test gives it
function site(answer: (url: string, body: string) => Response) {
  const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
  const f = (async (url: any, o: any) => { sent.push({ url: String(url), body: String(o?.body ?? ''), headers: o?.headers ?? {} }); return answer(String(url), String(o?.body ?? '')); }) as typeof fetch;
  return { acct: new BggAccount(f, 0), sent };
}
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });

test('sealToken / openToken: the token comes back only with the same key; linkKey wants 64 hex characters', () => {
  const sealed = sealToken(KEY, 'abc123');
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes('abc123'));
  assert.equal(openToken(KEY, sealed), 'abc123');
  assert.equal(openToken(linkKey('22'.repeat(32))!, sealed), null);
  assert.equal(openToken(KEY, 'v1.x.y'), null);
  assert.equal(linkKey('abc'), null);
  assert.equal(linkKey(undefined), null);
});

test('login: the bggpassword cookie is the token (with its expiry); a refused password or a missing cookie is "password"; 5xx is "unavailable"', async () => {
  const ok = site(() => {
    const h = new Headers();
    h.append('set-cookie', 'bggusername=nathan_bgc; expires=Tue, 26 Oct 2027 01:00:00 GMT; path=/');
    h.append('set-cookie', 'bggpassword=t0k3n%3D; expires=Tue, 26 Oct 2027 01:00:00 GMT; path=/');
    return new Response(null, { status: 204, headers: h });
  });
  assert.deepEqual(await ok.acct.login('nathan_bgc', 'pw'), { ok: true, token: 't0k3n=', expires: '2027-10-26T01:00:00.000Z' });
  assert.equal(ok.sent[0].url, 'https://boardgamegeek.com/login/api/v1');
  assert.deepEqual(JSON.parse(ok.sent[0].body), { credentials: { username: 'nathan_bgc', password: 'pw' } });

  assert.deepEqual(await site(() => new Response('{"errors":{"message":"bad"}}', { status: 401 })).acct.login('a', 'b'), { ok: false, reason: 'password' });
  assert.deepEqual(await site(() => new Response(null, { status: 204, headers: { 'set-cookie': 'bggpassword=deleted; path=/' } })).acct.login('a', 'b'), { ok: false, reason: 'password' });
  assert.deepEqual(await site(() => new Response('', { status: 503 })).acct.login('a', 'b'), { ok: false, reason: 'unavailable' });
});

test('savePlay: the play form (players[i][...]) with the session cookie; BGG\'s playid comes back; its login error means sign in again', async () => {
  const s = site(() => json({ playid: '98765', numplays: 3, html: '' }));
  const r = await s.acct.savePlay(S, { bggId: 13, date: '2026-10-25', minutes: 60, quantity: 1, location: '', comments: 'from BGC',
    players: [{ name: 'Nathan', username: 'nathan_bgc', win: true, score: '10', isNew: false, color: 'Red', position: '1', rating: '8' }, { name: 'Dan', username: '', win: false, score: '', isNew: true }] });
  assert.deepEqual(r, { ok: true, playId: 98765 });
  const sent = s.sent[0], f = new URLSearchParams(sent.body);
  assert.equal(sent.url, 'https://boardgamegeek.com/geekplay.php');
  assert.equal(sent.headers.Cookie, 'bggusername=nathan_bgc; bggpassword=tok%25en');
  assert.deepEqual([f.get('action'), f.get('objectid'), f.get('playdate'), f.get('length'), f.get('playid')], ['save', '13', '2026-10-25', '60', null]);
  assert.deepEqual([f.get('players[0][name]'), f.get('players[0][win]'), f.get('players[1][name]'), f.get('players[1][new]')], ['Nathan', '1', 'Dan', '1']);
  assert.deepEqual([f.get('players[0][color]'), f.get('players[0][position]'), f.get('players[0][rating]'), f.get('players[1][rating]')], ['Red', '1', '8', '0'], 'what BG Stats recorded goes back as it was');

  const again = site(() => json({ error: 'You must login to save plays' }));
  assert.deepEqual(await again.acct.savePlay(S, { bggId: 13, date: '2026-10-25', minutes: null, quantity: 1, location: '', comments: '', players: [] }),
    { ok: false, kind: 'auth', message: 'You must login to save plays' });
  const gone = site(() => json({ error: 'Play does not exist.' }));
  assert.equal(((await gone.acct.deletePlay(S, 5)) as any).kind, 'gone');
});

test('collection: additem, a status save that sends every flag, a rating in halves out of 10, and HTML asking to log in', async () => {
  const s = site(() => json({}));
  assert.deepEqual(await s.acct.addItem(S, 13), { ok: true });
  assert.deepEqual(await s.acct.saveStatus(S, 13, 444, { ...NO_STATUS, own: true, wishlist: false, fortrade: true }), { ok: true });
  assert.deepEqual(await s.acct.saveRating(S, 13, 444, 7.5), { ok: true });
  const [add, st, rate] = s.sent.map((x) => new URLSearchParams(x.body));
  assert.deepEqual([add.get('action'), add.get('objectid'), add.get('collid')], ['additem', '13', null]);
  assert.deepEqual([st.get('fieldname'), st.get('collid'), st.get('own'), st.get('fortrade'), st.get('wishlist'), st.get('wishlistpriority')], ['status', '444', '1', '1', '0', '3']);
  assert.deepEqual([rate.get('fieldname'), rate.get('rating')], ['rating', '7.5']);

  const html = site(() => new Response('<div>You must <a href="/login">login</a> to use the collection utilities.</div>', { status: 200 }));
  assert.equal(((await html.acct.saveRating(S, 13, null, null)) as any).kind, 'auth');
});

test('parseCollectionItem: the collid, every status flag and the rating; null when the game isn\'t there', () => {
  const xml = '<items totalitems="1"><item objecttype="thing" objectid="13" subtype="boardgame" collid="444"><name sortindex="1">Catan</name>' +
    '<stats><rating value="7.5"/></stats><status own="1" prevowned="0" fortrade="1" want="0" wanttoplay="0" wanttobuy="0" wishlist="1" wishlistpriority="2" preordered="0" lastmodified="2026-10-25"/></item></items>';
  assert.deepEqual(parseCollectionItem(xml, 13), { collId: 444, rating10: 7.5,
    status: { own: true, prevowned: false, fortrade: true, want: false, wanttoplay: false, wanttobuy: false, wishlist: true, wishlistpriority: 2, preordered: false } });
  assert.equal(parseCollectionItem(xml, 99), null);
});
