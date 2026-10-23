// Phase 3 reads: shelves, wishlist, rulebooks, memory, admin, and the per-area switch
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearer, fakeDb, get, makeApp, OWNER, token } from './helpers.js';

const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
const amy = async () => bearer(await token());
const dan = async () => bearer(await token({ email: OWNER }));

// A game row as at.request / bgc.shelf hand it over (Airtable-style field ids)
const game = (id: string, num: number, title: string, extra: Record<string, unknown> = {}) =>
  ({ id: 'rec' + id, fields: { fldJ1g6gtxWDwlWsI: id, fldMTwTBzGdIl5juS: num, fldOSxvCDWJdYbUZe: title, fldskzh1rq9uchgYI: true, ...extra } });

test('GET /vault/collection: Dan’s games, shaped as n8n does, in shelf order; anyone else is pointed to Friends', async () => {
  const db = fakeDb({ 'at.request': () => ({ records: [game('g2', 2, 'Azul'), game('g1', 1, 'Catan', { fldbWi7hhf2VGYzZl: 13, fldGj8TR8Qgr3awAe: '[3,4]' })] }) });
  const { app } = makeApp({ db });
  const r = await json(await get(app, '/vault/collection', await dan()));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.map((g: any) => g.title), ['Catan', 'Azul']);
  assert.deepEqual({ id: r.body[0].id, bggId: r.body[0].bggId, best: r.body[0].bestPlayers, thin: r.body[0].thinningCandidate, icon: r.body[0].icon }, { id: 'g1', bggId: 13, best: [3, 4], thin: true, icon: 'meeple' });
  assert.deepEqual(db.calls.at(-1)!.params, ['tblbGc0UuDxIPP2a8']);
  assert.deepEqual(await json(await get(app, '/vault/collection', await amy())), { status: 403, body: { ok: false, message: 'Open a friend’s shelf from Friends' } });
});

test('GET /vault/shelf: your own shelf and import progress', async () => {
  const db = fakeDb({ 'bgc.shelf': () => ({ name: 'Amy', bggUsername: 'amyb', status: { state: 'done' }, records: [game('a', 1, 'Patchwork')] }) });
  const { app } = makeApp({ db });
  const r = await json(await get(app, '/vault/shelf', await amy()));
  assert.deepEqual({ ...r.body, items: r.body.items.map((g: any) => g.title) }, { ok: true, name: 'Amy', bggUsername: 'amyb', status: { state: 'done' }, items: ['Patchwork'] });
  assert.deepEqual(db.calls.at(-1), { sql: 'SELECT bgc.shelf($1)', params: ['amy@example.com'] });
});

test('GET /vault/friends: your code and friends; a friend’s shelf; the database’s “not friends” passed on', async () => {
  const db = fakeDb({
    'bgc.friend_shelf': ([, id]) => (id === 5 ? { ok: true, name: 'Bo', records: [game('b', 1, 'Root')] } : { ok: false, status: 403, message: 'You’re not friends' }),
    'bgc.friends': () => ({ code: 'ABC123', friends: [{ id: 5, name: 'Bo' }] }),
  });
  const { app } = makeApp({ db });
  const t = await amy();
  assert.deepEqual((await json(await get(app, '/vault/friends', t))).body, { ok: true, code: 'ABC123', friends: [{ id: 5, name: 'Bo' }] });
  assert.deepEqual((await json(await get(app, '/vault/friends?shelf=abc', t))).body.code, 'ABC123'); // as in n8n: not a number, so the list
  const s = await json(await get(app, '/vault/friends?shelf=5', t));
  assert.deepEqual([s.body.name, s.body.items[0].title], ['Bo', 'Root']);
  assert.deepEqual(await json(await get(app, '/vault/friends?shelf=6', t)), { status: 403, body: { ok: false, message: 'You’re not friends' } });
  assert.equal((await get(app, '/vault/friends?shelf=99999999999999999999', t)).status, 400);
});

test('GET /vault/people: public cards only, best rating per person, your asks left; shelf names checked', async () => {
  const player = (id: string, name: string, active: boolean) => ({ id, fields: { fldWVws64FVcdtuSJ: name, fldCTgjMOoTTokadR: active, fldnwPL9Z33JcXoj2: name + '@x.com', fld7R2WFALqZ2gkR7: 'secret likes', fldGI1Kr6p107QdZp: '{}' } });
  const rating = (p: string, g: string, stars: number, source: string) => ({ id: 'r' + p + g + source, fields: { fldB2cw5ie4ypHPGl: p, fldhrJoBfiLAg1E8q: g, fldSM283jOPAOs2YP: stars, fldaPLq2gL3UP6zon: source } });
  const db = fakeDb({
    'bgc.shelf_view': () => ({
      v: { players: [player('p2', 'Zed', true), player('p1', 'Amy', true), player('p3', 'Old', false)], ratings: [rating('p1', 'g1', 4, 'site'), rating('p1', 'g1', 4.5, 'bgg')],
        askerKey: 'p1', ownerKey: 'p9', shelf: 'main' },
      mine: { g1: 4 }, used: 3, lim: 30,
    }),
  });
  const { app } = makeApp({ db });
  const r = await json(await get(app, '/vault/people', await amy()));
  assert.deepEqual(r.body.players.map((p: any) => p.name), ['Amy', 'Zed', 'Old']);
  assert.equal(r.body.players[0].googleEmail, undefined);
  assert.equal(r.body.players[0].likes, undefined);
  assert.deepEqual(r.body.ratings, { g1: { p1: { stars: 4, bgg: 9 } } });
  assert.deepEqual([r.body.me, r.body.owner, r.body.mine, r.body.shelf, r.body.asks], ['p1', 'p9', { g1: 4 }, 'main', { limit: 30, left: 27 }]);
  assert.deepEqual(db.calls.at(-1)!.params, ['amy@example.com', 'main', 'recAmy']);
  for (const [q, shelf] of [['mine', 'mine'], ['friend:12', 'friend:12'], ['friend:x', 'main'], ["mine'; DROP", 'main']]) {
    await get(app, '/vault/people?shelf=' + encodeURIComponent(q), await amy());
    assert.equal(db.calls.at(-1)!.params[1], shelf, q);
  }
});

test('GET /vault/wishlist and /vault/memory: passed through, inputs cleaned as n8n did', async () => {
  const db = fakeDb({
    'bgc.wishlist': ([, f]) => (f === 99 ? { ok: false, status: 403, message: 'Not friends' } : { ok: true, items: [], friend: f }),
    'bgc.memory_page': ([, chat]) => ({ ok: true, notes: [], chat }),
  });
  const { app } = makeApp({ db });
  const t = await amy();
  assert.deepEqual((await json(await get(app, '/vault/wishlist', t))).body, { ok: true, items: [], friend: null });
  assert.deepEqual((await json(await get(app, '/vault/wishlist?friend=4', t))).body.friend, 4);
  assert.equal((await get(app, '/vault/wishlist?friend=99', t)).status, 403);
  assert.equal((await get(app, '/vault/wishlist?friend=abc', t)).status, 400);
  assert.deepEqual((await json(await get(app, '/vault/memory?chat=' + encodeURIComponent("ab-12'; x"), t))).body.chat, 'ab-12x');
  assert.deepEqual((await json(await get(app, '/vault/memory', t))).body.chat, '');
});

test('GET /vault/rulebook: one game’s documents, or which games have any (members only)', async () => {
  const db = fakeDb({ 'bgc.rule_doc_games': () => [13, 822], 'bgc.rule_docs_of': ([, bgg]) => ({ ok: true, bgg, docs: [] }) });
  const { app } = makeApp({ db });
  assert.deepEqual((await json(await get(app, '/vault/rulebook?games=1', await amy()))).body, { ok: true, games: [13, 822] });
  assert.deepEqual((await json(await get(app, '/vault/rulebook?bgg=13', await amy()))).body, { ok: true, bgg: 13, docs: [] });
  assert.deepEqual((await json(await get(app, '/vault/rulebook?bgg=x', await amy()))).body.bgg, 0);
  // Dan is the owner without being on the invite list in this stand-in, so not a member
  const db2 = fakeDb({ 'bgc.sign_in': () => ({ member: false }) });
  assert.deepEqual(await json(await get(makeApp({ db: db2 }).app, '/vault/rulebook?games=1', await dan())), { status: 403, body: { ok: false, message: 'Members only' } });
});

test('admin reads: the database decides who’s an admin; Players Admin is for the owner', async () => {
  const no = { ok: false, status: 403, message: 'Admins only' };
  const db = fakeDb({
    'bgc.admin_overview': ([e]) => (e === OWNER ? { ok: true, members: [] } : no),
    'bgc.dashboard': ([e]) => (e === OWNER ? { ok: true, selfTest: null } : no),
    'bgc.costs_page': ([e]) => (e === OWNER ? { ok: true, fixed: [] } : no),
    'at.request': () => ({ records: [{ id: 'p1', fields: { fldWVws64FVcdtuSJ: 'Bo', fldCTgjMOoTTokadR: true, fldGI1Kr6p107QdZp: '{"g1":{"plays":3},"g2":{"plays":2}}' } }] }),
  });
  const { app } = makeApp({ db });
  for (const p of ['/vault/admin', '/vault/dashboard', '/vault/costs']) {
    assert.equal((await get(app, p, await dan())).status, 200, p);
    assert.deepEqual(await json(await get(app, p, await amy())), { status: 403, body: { ok: false, message: 'Admins only' } }, p);
  }
  assert.deepEqual((await json(await get(app, '/vault/players-admin', await dan()))).body.players.map((p: any) => [p.name, p.games, p.plays, p.history]), [['Bo', 2, 5, undefined]]);
  assert.equal((await get(app, '/vault/players-admin', await amy())).status, 401);
});

test('areas: each switch sends its routes to this service; admins-only for admins; Nathan on his own switch', async () => {
  let areas: Record<string, string> = {};
  const db = fakeDb({
    'api_areas': (p) => { if (p.length) { areas = { ...areas, [p[0] as string]: p[1] as string }; return null; } return areas; },
    'nathan_api': () => 'admins',
  });
  const { app } = makeApp({ db });
  assert.deepEqual((await json(await get(app, '/vault/routes', await amy()))).body, { ok: true, routes: [] });
  const set = async (t: Record<string, string>, body: unknown) => app.request('/vault/api-areas', { method: 'POST', headers: { ...t, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await set(await amy(), { area: 'shelves', mode: 'everyone' })).status, 403);
  assert.equal((await set(await dan(), { area: 'nope', mode: 'everyone' })).status, 400);
  assert.equal((await set(await dan(), { area: 'shelves', mode: 'everyone' })).status, 200);
  assert.equal((await set(await dan(), { area: 'admin', mode: 'admins' })).status, 200);
  assert.deepEqual((await json(await get(app, '/vault/routes', await amy()))).body.routes, ['GET /collection', 'GET /shelf', 'GET /people', 'GET /friends']);
  assert.deepEqual((await json(await get(app, '/vault/routes', await dan()))).body.routes.slice(4), ['GET /admin', 'GET /dashboard', 'GET /costs', 'GET /players-admin']);
  const a = await json(await get(app, '/vault/api-areas', await dan()));
  assert.deepEqual(a.body.areas, { account: 'off', shelves: 'everyone', wishlist: 'off', rulebooks: 'off', admin: 'admins', accountChanges: 'off', wishlistChanges: 'off', rulebookChanges: 'off', shelfChanges: 'off', friendChanges: 'off', adminChanges: 'off', addGames: 'off' });
  assert.equal((await get(app, '/vault/api-areas', await amy())).status, 403);
});
