// Linking BGG, logging a play, and the outbox that sends both to BGG
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bgg } from '../src/bgg.js';
import { linkKey, NO_STATUS, openToken, sealToken } from '../src/bggAccount.js';
import { loadConfig } from '../src/config.js';
import { bggOutbox, plan, withKnown } from '../src/jobs/bggOutbox.js';
import type { JobCtx } from '../src/jobs/types.js';
import { bearer, fakeDb, fakeJobs, makeApp, token } from './helpers.js';

const KEY_HEX = 'ab'.repeat(32);
const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
const post = async (app: any, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

// boardgamegeek.com: a sign-in that works for one password, and whatever the test wants for the rest
function bggSite(more: (url: string, body: string) => Response | null = () => null) {
  const sent: { url: string; body: string }[] = [];
  const f = (async (url: any, o: any) => {
    const u = String(url), b = String(o?.body ?? '');
    sent.push({ url: u, body: b });
    if (u.endsWith('/login/api/v1')) {
      const ok = JSON.parse(b).credentials.password === 'right';
      return ok ? new Response(null, { status: 204, headers: { 'set-cookie': 'bggpassword=sess10n; expires=Tue, 26 Oct 2027 01:00:00 GMT; path=/' } })
        : new Response('{"errors":{"message":"Invalid username or password"}}', { status: 401 });
    }
    return more(u, b) ?? new Response('?', { status: 404 });
  }) as typeof fetch;
  return { f, sent };
}

test('POST /vault/bgg-link: a good sign-in keeps BGG\'s token sealed (never the password) and starts the outbox', async () => {
  const site = bggSite();
  const jobs = fakeJobs();
  const db = fakeDb({ 'bgc.bgg_link_save': (p) => ({ ok: true, got: p }) });
  const { app } = makeApp({ db, fetch: site.f, jobs, env: { BGG_LINK_KEY: KEY_HEX } });
  const r = await json(await post(app, '/vault/bgg-link', { action: 'link', username: 'nathan_bgc', password: 'right' }));
  assert.equal(r.status, 200);
  const [, username, sealed, expires] = r.body.got;
  assert.equal(username, 'nathan_bgc');
  assert.equal(openToken(linkKey(KEY_HEX)!, sealed), 'sess10n');
  assert.ok(!JSON.stringify(r.body.got).includes('right'), 'the password never reaches the database');
  assert.equal(expires, '2027-10-26T01:00:00.000Z');
  assert.deepEqual(jobs.runs.map((x) => x.name), ['bggOutbox']);
});

test('POST /vault/bgg-link: a wrong password is a plain 400; five tries an hour; no key means not set up; unlink', async () => {
  const site = bggSite();
  const db = fakeDb({ 'bgc.bgg_link_remove': () => ({ ok: true, link: { linked: false } }), 'bgc.bgg_link_settings': (p) => ({ ok: true, got: p }) });
  const { app } = makeApp({ db, fetch: site.f, env: { BGG_LINK_KEY: KEY_HEX } });
  for (let i = 0; i < 5; i++) assert.equal((await json(await post(app, '/vault/bgg-link', { action: 'link', username: 'nathan_bgc', password: 'wrong' }))).body.message, 'BGG didn’t accept that username and password');
  assert.equal((await post(app, '/vault/bgg-link', { action: 'link', username: 'nathan_bgc', password: 'right' })).status, 429);
  assert.equal((await post(app, '/vault/bgg-link', { action: 'link', username: 'bad name!', password: 'x' })).status, 400);
  assert.equal((await json(await post(app, '/vault/bgg-link', { action: 'unlink' }))).body.link.linked, false);
  assert.deepEqual(JSON.parse((await json(await post(app, '/vault/bgg-link', { action: 'settings', ratings: false }))).body.got[1]), { ratings: false });
  assert.equal((await post(app, '/vault/bgg-link', { action: 'settings', ratings: 'no' })).status, 400);
  const { app: noKey } = makeApp({ db, fetch: site.f });
  assert.equal((await post(noKey, '/vault/bgg-link', { action: 'link', username: 'nathan_bgc', password: 'right' })).status, 503);
});

test('POST /vault/log-play: a checked play reaches bgc.log_play; one going to BGG starts the outbox; a bad one never reaches the database', async () => {
  const jobs = fakeJobs();
  const db = fakeDb({ 'bgc.log_play': (p) => ({ ok: true, toBgg: true, playCount: 4, got: p }) });
  const { app } = makeApp({ db, jobs });
  const r = await json(await post(app, '/vault/log-play', { gameId: 'recABC', date: '2026-10-25', minutes: '45', players: [{ name: ' Nathan ', win: true }, { name: 'Dan' }] }));
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body.got[2]), { gameId: 'recABC', title: '', cover: '', date: '2026-10-25', minutes: 45, location: '', comments: '', players: [{ name: 'Nathan', win: true }, { name: 'Dan', win: false }] });
  assert.deepEqual(jobs.runs.map((x) => x.name), ['bggOutbox']);
  for (const bad of [{ gameId: 'recABC', date: '2026-10-25', players: [] }, { gameId: 'recABC', date: '2999-01-01', players: [{ name: 'A' }] }, { gameId: 'recABC', date: 'yesterday', players: [{ name: 'A' }] }])
    assert.equal((await post(app, '/vault/log-play', bad)).status, 400);
  assert.equal(db.calls.filter((c) => c.sql.includes('bgc.log_play')).length, 1);
});

test('POST /vault/log-play for a game you don\'t own; GET /vault/plays; POST /vault/play-delete', async () => {
  const jobs = fakeJobs();
  const db = fakeDb({ 'bgc.log_play': (p) => ({ ok: true, toBgg: false, got: p }), 'bgc.my_plays': (p) => ({ ok: true, plays: [], got: p }), 'bgc.play_delete': (p) => ({ ok: true, fromBgg: true, got: p }), 'bgc.play_places': () => ['Home', 'Keith’s'] });
  const { app } = makeApp({ db, jobs });
  const r = await json(await post(app, '/vault/log-play', { bggId: '266192', title: 'Wingspan', cover: 'https://cf.geekdo-images.com/w.jpg', date: '2026-10-25', location: '  Keith’s ', players: [{ name: 'Amy' }] }));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body.got[2]).location, 'Keith’s');
  assert.deepEqual((await json(await app.request('/vault/play-places', { headers: bearer(await token()) }))).body.places, ['Home', 'Keith’s']);
  assert.equal(r.body.got[1], null);
  assert.deepEqual([JSON.parse(r.body.got[2]).bggId, JSON.parse(r.body.got[2]).title], [266192, 'Wingspan']);
  assert.equal((await post(app, '/vault/log-play', { gameId: 'rec1', bggId: 5, date: '2026-10-25', players: [{ name: 'A' }] })).status, 400, 'one game, not two');
  assert.equal((await post(app, '/vault/log-play', { date: '2026-10-25', players: [{ name: 'A' }] })).status, 400, 'or none');
  const list = await json(await app.request('/vault/plays?skip=50', { headers: bearer(await token()) }));
  assert.deepEqual(list.body.got.slice(1), [50]);
  assert.equal((await app.request('/vault/plays?skip=-1', { headers: bearer(await token()) })).status, 400);
  const del = await json(await post(app, '/vault/play-delete', { id: 70 }));
  assert.deepEqual(del.body.got.slice(1), [70]);
  assert.deepEqual(jobs.runs.map((x) => x.name), ['bggOutbox'], 'a play on BGG is deleted there right away');
});

test('POST /vault/plays-sync: sends what is waiting, then brings in BGG plays; no BGG username is a plain 400', async () => {
  const jobs = fakeJobs();
  let user = 'amy_bgg';
  const db = fakeDb({ 'bgc.my_plays': () => ({ ok: true, plays: [], linked: true, bggUsername: user }), 'bgc.start_import': (p) => ({ ok: true, got: p }) });
  const { app } = makeApp({ db, jobs });
  const r = await json(await post(app, '/vault/plays-sync', {}));
  assert.deepEqual([r.status, r.body.started], [200, true]);
  assert.deepEqual(jobs.runs.map((x) => [x.name, x.wait]), [['bggOutbox', true], ['memberPlays', false]]);
  assert.deepEqual(jobs.runs[1].params, { email: 'amy@example.com', username: 'amy_bgg' });
  user = '';
  assert.equal((await post(app, '/vault/plays-sync', {})).status, 400);
});

test('people, places, and changing a play: checked inputs reach the database; a change on BGG starts the outbox', async () => {
  const jobs = fakeJobs();
  const db = fakeDb({ 'bgc.person_save': (p) => ({ ok: true, got: p }), 'bgc.person_remove': (p) => ({ ok: true, got: p }), 'bgc.my_people': () => ({ ok: true, people: [] }),
    'bgc.place_save': (p) => ({ ok: true, got: p }), 'bgc.my_places': () => ({ ok: true, places: [] }),
    'bgc.play_get': (p) => ({ ok: true, play: { id: Number(p[1]) } }), 'bgc.play_edit': (p) => ({ ok: true, toBgg: true, got: p }),
    'bgc.person_merge': (p) => ({ ok: true, got: p }), 'bgc.place_merge': (p) => ({ ok: true, got: p }) });
  const { app } = makeApp({ db, jobs });
  const s = await json(await post(app, '/vault/person-save', { name: ' Grandma Joan ', aliases: 'Joan, Gran ,', active: false }));
  assert.deepEqual([s.body.got[1], JSON.parse(s.body.got[2])], [null, { name: 'Grandma Joan', aliases: ['Joan', 'Gran'], active: false, bggUsername: '' }]);
  assert.equal((await post(app, '/vault/person-save', { name: '' })).status, 400);
  assert.equal((await post(app, '/vault/person-save', { name: 'X', bggUsername: 'not ok!' })).status, 400);
  assert.deepEqual((await json(await post(app, '/vault/person-remove', { id: 'recP' }))).body.got.slice(1), ['recP']);
  assert.deepEqual(JSON.parse((await json(await post(app, '/vault/place-save', { action: 'add', name: ' Keith’s ' }))).body.got[1]), { action: 'add', name: 'Keith’s' });
  assert.equal((await post(app, '/vault/place-save', { action: 'rename', name: 'X' })).status, 400);
  assert.equal((await json(await app.request('/vault/play?id=70', { headers: bearer(await token()) }))).body.play.id, 70);
  const e = await json(await post(app, '/vault/play-edit', { id: 70, date: '2026-10-24', minutes: 40, location: 'Home', players: [{ name: 'Amy', win: true }] }));
  assert.deepEqual([e.body.got[1], JSON.parse(e.body.got[2]).location], [70, 'Home']);
  assert.equal((await post(app, '/vault/play-edit', { id: 70, date: '2026-10-24', players: [] })).status, 400);
  assert.deepEqual(jobs.runs.map((x) => x.name), ['bggOutbox']);
  const pm = await json(await post(app, '/vault/person-merge', { from: 'recJo', into: 'recJoan' }));
  assert.deepEqual(pm.body.got.slice(1), ['recJo', 'recJoan']);
  const lm = await json(await post(app, '/vault/place-merge', { from: ' Game café ', into: 'Game Night Cafe' }));
  assert.deepEqual(lm.body.got.slice(1), ['Game café', 'Game Night Cafe']);
  assert.equal((await post(app, '/vault/place-merge', { from: 'X' })).status, 400);
});

test('plan: only what differs from BGG; a new game is added first; removing marks it previously owned; a cleared rating on a game BGG lacks sends nothing', () => {
  const cur = { collId: 5, rating10: 7, status: { ...NO_STATUS, own: true, fortrade: true } };
  assert.deepEqual(plan(null, { own: true, rating10: 8 }), ['add', 'status', 'rating']);
  assert.deepEqual(plan(cur, { own: true, rating10: 7 }), []);
  assert.deepEqual(plan(cur, { rating10: 8 }), ['rating']);
  assert.deepEqual(plan(cur, { own: false }), ['status']);
  assert.deepEqual(plan(null, { rating10: null }), []);
  assert.deepEqual(plan(null, { own: false }), []);
});

test('withKnown: BGG\'s XML can be an older copy, so what we sent lately wins for our fields; BGG\'s other flags stay', () => {
  // Wingspan wished for a minute ago; the XML still says it isn't in the collection. Removing the wish must still be sent.
  const known = { collId: null, own: null, prevowned: null, wishlist: true, rating10: null };
  assert.deepEqual(plan(withKnown(null, known), { wishlist: false }), ['status']);
  const stale = { collId: 5, rating10: 7, status: { ...NO_STATUS, own: true, wanttoplay: true, wishlist: false } };
  const merged = withKnown(stale, { collId: 5, own: null, prevowned: null, wishlist: true, rating10: 9 })!;
  assert.deepEqual([merged.status.own, merged.status.wanttoplay, merged.status.wishlist, merged.rating10], [true, true, true, 9]);
  assert.equal(withKnown(stale, null), stale);
});

test('bggOutbox: a play goes to geekplay.php and its BGG id comes back; a rating keeps every other flag; a refused token stops that member', async () => {
  const key = linkKey(KEY_HEX)!;
  const sealed = sealToken(key, 'sess10n');
  const rows = [
    { id: 1, memberId: 7, kind: 'play', bggId: 13, tries: 0, username: 'amy_bgg', sealed, want: {},
      play: { id: 70, bggPlayId: null, date: '2026-10-25', minutes: 45, quantity: 1, location: '', comments: '', players: [{ name: 'Amy', username: 'amy_bgg', win: true, score: '', isNew: false }] } },
    { id: 2, memberId: 7, kind: 'item', bggId: 13, tries: 0, username: 'amy_bgg', sealed, want: { rating10: 9 }, play: null },
    { id: 3, memberId: 8, kind: 'item', bggId: 13, tries: 0, username: 'bob_bgg', sealed: sealToken(key, 'old'), want: { own: false }, play: null },
    { id: 4, memberId: 8, kind: 'item', bggId: 14, tries: 0, username: 'bob_bgg', sealed: sealToken(key, 'old'), want: { own: true }, play: null },
    { id: 5, memberId: 9, kind: 'unplay', bggId: 13, tries: 0, username: 'cy_bgg', sealed, want: { bggPlayId: 444 }, play: null },
    // Also logged in BG Stats: BGG already has it (777), so it's matched, not posted again
    { id: 6, memberId: 7, kind: 'play', bggId: 13, tries: 0, username: 'amy_bgg', sealed, want: {},
      play: { id: 71, bggPlayId: null, date: '2026-10-20', minutes: 30, quantity: 1, location: '', comments: '', players: [{ name: 'Amy', username: 'amy_bgg', win: false, score: '', isNew: false }, { name: 'Bo', username: '', win: true, score: '', isNew: false }] } },
  ];
  const results: any[] = [];
  const db = fakeDb({ 'bgc.bgg_out_next': () => rows, 'bgc.bgg_out_result': (p) => { results.push([p[0], JSON.parse(p[1] as string)]); return true; }, 'bgg_play_id::text': () => [] });
  const site = bggSite((u, b) => {
    if (u.includes('xmlapi2/plays')) return new Response(u.includes('mindate=2026-10-20')
      ? '<plays><play id="777" date="2026-10-20" quantity="1" length="30"><item name="Catan" objecttype="thing" objectid="13"/><players><player name="bo" win="1"/><player username="amy_bgg" name="Amy" win="0"/></players></play></plays>'
      : '<plays username="amy_bgg" total="0"></plays>');
    if (u.includes('xmlapi2/collection')) return new Response('<items><item objecttype="thing" objectid="13" subtype="boardgame" collid="900"><stats><rating value="7"/></stats><status own="1" fortrade="1" wishlist="0"/></item></items>');
    if (u.endsWith('/geekplay.php')) return new URLSearchParams(b).get('action') === 'delete' ? Response.json({ error: 'Play does not exist.' }) : Response.json({ playid: '555', numplays: 1 });
    if (u.endsWith('/geekcollection.php')) return b.includes('bggpassword=old') || new URLSearchParams(b).get('fieldname') === null ? Response.json({}) : Response.json({});
    return null;
  });
  // Bob's token is no good any more: BGG's collection utilities answer with the login prompt
  const f = (async (url: any, o: any) => (String(o?.headers?.Cookie || '').includes('bggpassword=old')
    ? new Response('You must <a href="/login">login</a> to use the collection utilities.') : site.f(url, o))) as typeof fetch;
  const config = loadConfig({ DATABASE_URL: 'postgres://unused', BGG_TOKEN: 'bgg', BGG_LINK_KEY: KEY_HEX });
  const ctx: JobCtx = { db, fetch: f, config, bgg: new Bgg(f, 'bgg', 0), mail: async () => true };
  const out: any = await bggOutbox.run(ctx, { gapMs: 0 });
  assert.deepEqual(out, { waiting: 6, sent: 4, retry: 0, signIn: 1, gone: 0 });
  assert.deepEqual(results.map((r) => [r[0], r[1].outcome, r[1].bggPlayId]), [[1, 'ok', 555], [2, 'ok', null], [3, 'auth', null], [5, 'ok', null], [6, 'ok', 777]],
    'a play already gone from BGG counts as deleted; one already on BGG is matched');
  assert.equal(site.sent.filter((s) => s.url.endsWith('/geekplay.php') && new URLSearchParams(s.body).get('action') === 'save').length, 1, 'only the new play was posted');
  const rating = site.sent.find((s) => s.url.endsWith('/geekcollection.php'))!;
  assert.deepEqual([...new URLSearchParams(rating.body)].filter(([k]) => ['fieldname', 'rating', 'collid'].includes(k)), [['collid', '900'], ['fieldname', 'rating'], ['rating', '9']]);
  assert.equal(site.sent.filter((s) => new URLSearchParams(s.body).get('fieldname') === 'status').length, 0, 'nothing else changed, so no status save');
});

test('bggOutbox: without BGG_LINK_KEY it does nothing', async () => {
  const db = fakeDb();
  const config = loadConfig({ DATABASE_URL: 'postgres://unused' });
  const out = await bggOutbox.run({ db, fetch: fetch, config, bgg: new Bgg(fetch, undefined, 0), mail: async () => true }, {});
  assert.deepEqual(out, { skipped: 'BGG_LINK_KEY is not set' });
  assert.equal(db.calls.length, 0);
});
