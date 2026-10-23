// Phase 3 changes: profile, Nathan's memory, wishlist, rulebook details. Inputs are checked by n8n's own Validate code,
// so these check what reaches the database, and that a bad input never does.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearer, fakeDb, makeApp, token } from './helpers.js';

const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });
const post = async (app: any, path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { ...bearer(await token()), 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const callsTo = (db: ReturnType<typeof fakeDb>, fn: string) => db.calls.filter((c) => c.sql.includes(fn));

test('POST /vault/me-save: the profile as n8n cleans it; a bad BGG name never reaches the database', async () => {
  const db = fakeDb({ 'bgc.save_profile': ([, p]) => ({ ok: true, profile: JSON.parse(p as string) }) });
  const { app } = makeApp({ db });
  const r = await json(await post(app, '/vault/me-save', {
    bggUsername: ' amy_b ', age: '41.6', complexity: 9, conflict: '', luck: 0, likes: '  co-op  ', notes: 'x'.repeat(700),
    topGames: [{ bggId: 13, title: 'Catan', cover: 'https://evil.example.com/x.png' }, { bggId: 13, title: 'Catan again' }, { bggId: 0, title: 'No id' }],
  }));
  assert.equal(r.status, 200);
  const p = r.body.profile;
  assert.deepEqual([p.bggUsername, p.age, p.complexity, p.conflict, p.luck, p.likes, p.notes.length], ['amy_b', 42, 5, null, 1, 'co-op', 600]);
  assert.deepEqual(p.topGames, [{ bggId: 13, title: 'Catan', cover: null }]);
  assert.equal(callsTo(db, 'save_profile')[0].params[0], 'amy@example.com');
  assert.deepEqual(await json(await post(app, '/vault/me-save', { bggUsername: 'amy<script>' })), { status: 400, body: { ok: false, message: 'That BGG username doesn’t look right' } });
  assert.equal(callsTo(db, 'save_profile').length, 1);
});

test('POST /vault/memory: forget one note or everything; anything else is a 400', async () => {
  const db = fakeDb({ 'bgc.memory_forget': ([, id]) => ({ ok: true, forgot: id }) });
  const { app } = makeApp({ db });
  assert.deepEqual((await json(await post(app, '/vault/memory', { action: 'forget', id: 12 }))).body, { ok: true, forgot: '12' });
  assert.deepEqual((await json(await post(app, '/vault/memory', { action: 'forgetAll' }))).body, { ok: true, forgot: '' });
  for (const bad of [{ action: 'forget', id: -1 }, { action: 'forget', id: '1; DROP' }, { action: 'nope' }, 'not json', [1]]) {
    assert.deepEqual(await json(await post(app, '/vault/memory', bad)), { status: 400, body: { ok: false, message: 'Say which note to forget' } }, JSON.stringify(bad));
  }
  assert.equal(callsTo(db, 'memory_forget').length, 2);
});

test('POST /vault/wishlist: add or remove a BGG game; covers only from BGG; no game is a 400', async () => {
  const db = fakeDb({ 'bgc.wish_change': (p) => ({ ok: true, got: p }) });
  const { app } = makeApp({ db });
  const r = await json(await post(app, '/vault/wishlist', { action: 'add', bggId: '13', title: ' Catan ', cover: 'https://cf.geekdo-images.com/a.jpg' }));
  assert.deepEqual(r.body.got, ['amy@example.com', 'add', '13', 'Catan', 'https://cf.geekdo-images.com/a.jpg']);
  assert.deepEqual((await json(await post(app, '/vault/wishlist', { action: 'remove', bggId: 13, cover: 'https://x.com/a.jpg' }))).body.got, ['amy@example.com', 'remove', '13', '', '']);
  assert.equal((await json(await post(app, '/vault/wishlist', { action: 'whatever', bggId: 13 }))).body.got[1], 'add'); // as in n8n: anything but remove adds
  assert.deepEqual(await json(await post(app, '/vault/wishlist', { action: 'add', title: 'No id' })), { status: 400, body: { ok: false, message: 'Pick a game from BoardGameGeek' } });
  assert.equal(callsTo(db, 'wish_change').length, 3);
});

test('POST /vault/rulebook-change: edit a document’s details or remove it; the database says who may', async () => {
  const db = fakeDb({ 'bgc.rule_doc_change': ([, id, action, patch]) => (id === '9' ? { ok: false, status: 403, message: 'Only who added it can change it' } : { ok: true, id, action, patch: JSON.parse(patch as string) }) });
  const { app } = makeApp({ db });
  assert.deepEqual((await json(await post(app, '/vault/rulebook-change', { id: 4, title: ' FAQ ', kind: 'faq', source: 7, extra: 'x' }))).body, { ok: true, id: '4', action: 'edit', patch: { title: 'FAQ', kind: 'faq' } });
  assert.deepEqual((await json(await post(app, '/vault/rulebook-change', { id: 4, action: 'remove' }))).body.action, 'remove');
  assert.deepEqual(await json(await post(app, '/vault/rulebook-change', { id: 9, action: 'remove' })), { status: 403, body: { ok: false, message: 'Only who added it can change it' } });
  assert.deepEqual(await json(await post(app, '/vault/rulebook-change', { id: 'x' })), { status: 400, body: { ok: false, message: 'Which document?' } });
  assert.equal(callsTo(db, 'rule_doc_change').length, 3);
});

test('changes need a sign-in like everything else', async () => {
  const { app, db } = makeApp();
  for (const p of ['/vault/me-save', '/vault/memory', '/vault/wishlist', '/vault/rulebook-change']) {
    const r = await app.request(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401, p);
  }
  assert.equal(db.calls.length, 0);
});

test('POST /vault/rate: your own stars, rounded to halves; out of range never reaches the database', async () => {
  const db = fakeDb({ 'bgc.rate': (p) => ({ ok: true, got: p }) });
  const { app } = makeApp({ db });
  assert.deepEqual((await json(await post(app, '/vault/rate', { gameId: ' g1 ', stars: 3.3 }))).body.got, ['amy@example.com', 'g1', '3.5']);
  assert.deepEqual((await json(await post(app, '/vault/rate', { gameId: 'g1', stars: 0 }))).body.got[2], '0');
  assert.deepEqual(await json(await post(app, '/vault/rate', { gameId: 'g1', stars: 6 })), { status: 400, body: { ok: false, message: 'stars must be 0-5 (0 clears your rating)' } });
  assert.deepEqual(await json(await post(app, '/vault/rate', { stars: 3 })), { status: 400, body: { ok: false, message: 'Missing gameId' } });
  assert.equal(callsTo(db, 'bgc.rate').length, 2);
});

test('POST /vault/shelf-update, /shelf-remove and /friends: passed to the database as n8n did', async () => {
  const db = fakeDb({
    'bgc.shelf_update': (p) => ({ ok: true, got: p }), 'bgc.shelf_remove': ([, id]) => (id === 'nope' ? { ok: false, status: 404, message: 'Not on your shelf' } : { ok: true, id }),
    'bgc.add_friend': ([, code]) => (code === 'BAD' ? { ok: false, status: 404, message: 'No one has that code' } : { ok: true, code }), 'bgc.remove_friend': ([, id]) => ({ ok: true, removed: id }),
  });
  const { app } = makeApp({ db });
  assert.deepEqual((await json(await post(app, '/vault/shelf-update', { id: 7, fields: { favorite: true } }))).body.got, ['amy@example.com', '7', '{"favorite":true}']);
  assert.deepEqual((await json(await post(app, '/vault/shelf-remove', { id: 'x1' }))).body, { ok: true, id: 'x1' });
  assert.deepEqual(await json(await post(app, '/vault/shelf-remove', { id: 'nope' })), { status: 404, body: { ok: false, message: 'Not on your shelf' } });
  assert.deepEqual((await json(await post(app, '/vault/friends', { code: 'ABC123' }))).body, { ok: true, code: 'ABC123' });
  assert.deepEqual(await json(await post(app, '/vault/friends', { action: 'add', code: 'BAD' })), { status: 404, body: { ok: false, message: 'No one has that code' } });
  assert.deepEqual((await json(await post(app, '/vault/friends', { action: 'remove', id: '12' }))).body, { ok: true, removed: '12' });
  assert.deepEqual((await json(await post(app, '/vault/friends', { action: 'remove', id: 'x' }))).body, { ok: true, removed: '' });
});

test('POST /vault/update and /delete: Dan’s collection, the owner only; fields checked as in n8n; an unknown game is a 404', async () => {
  const db = fakeDb({ 'at.request': (p) => (p.length === 3 ? { path: p[1], payload: p[2] } // PATCH: table, path, body
    : String(p[1]).startsWith('/') ? { deleted: true } // DELETE: table, path
    : { records: p[1] === "{GameID}='g1'" ? [{ id: 'recAAAAAAAAAAAAAA', fields: { fldOSxvCDWJdYbUZe: 'Catan' } }] : [] }) });
  const { app } = makeApp({ db });
  const dan = async (p: string, b: unknown) => app.request(p, { method: 'POST', headers: { ...bearer(await token({ email: 'owner@example.com' })), 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  assert.deepEqual(await json(await post(app, '/vault/update', { id: 'g1', fields: { favorite: true } })), { status: 401, body: { ok: false, message: 'Sign in as the collection owner to make changes' } });
  assert.deepEqual((await json(await dan('/vault/update', { id: 'g1', fields: { favorite: true, desireToPlay: 4 } }))).body, { ok: true, id: 'g1' });
  const patch = callsTo(db, 'at.request').at(-1)!.params;
  assert.deepEqual([patch[1], JSON.parse(patch[2] as string).fields.fldyfp0FG1zY0K4qu, JSON.parse(patch[2] as string).fields.fldV5vlwouSyJcPjY], ['/recAAAAAAAAAAAAAA', true, 4]);
  assert.deepEqual(await json(await dan('/vault/update', { id: 'g1', fields: { owner: 'me' } })), { status: 400, body: { ok: false, message: 'Field not editable: owner' } });
  assert.deepEqual(await json(await dan('/vault/update', { id: 'g9', fields: { favorite: true } })), { status: 404, body: { ok: false, message: 'Game not found: g9' } });
  assert.deepEqual((await json(await dan('/vault/delete', { id: 'g1' }))).body, { ok: true, id: 'g1', title: 'Catan' });
  assert.equal(callsTo(db, "'DELETE'").length, 1);
  assert.equal((await post(app, '/vault/delete', { id: 'g1' })).status, 401);
});

test('POST /vault/player-save: owner only; a new card or an existing one; the email checked as in n8n', async () => {
  const db = fakeDb({ 'at.request': (p) => (p.length === 3 ? { id: String(p[1]).slice(1), fields: JSON.parse(p[2] as string).fields } // PATCH
    : { id: 'recNEWNEWNEWNEWNE', fields: JSON.parse(p[1] as string).fields }) });
  const { app } = makeApp({ db });
  const dan = async (b: unknown) => app.request('/vault/player-save', { method: 'POST', headers: { ...bearer(await token({ email: 'owner@example.com' })), 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  assert.equal((await post(app, '/vault/player-save', { name: 'Bo' })).status, 401);
  const made = await json(await dan({ name: ' Bo ', aliases: 'Bobby, B', active: true }));
  assert.deepEqual([made.body.player.id, made.body.player.name, made.body.player.aliases, made.body.player.active], ['recNEWNEWNEWNEWNE', 'Bo', ['Bobby', 'B'], true]);
  assert.equal((await json(await dan({ id: 'recAAAAAAAAAAAAAA', name: 'Bo' }))).body.player.id, 'recAAAAAAAAAAAAAA');
  assert.deepEqual(await json(await dan({ name: 'Bo', googleEmail: 'not an email' })), { status: 400, body: { ok: false, message: 'That Google email doesn’t look right' } });
  assert.deepEqual(await json(await dan({ name: '' })), { status: 400, body: { ok: false, message: 'A player needs a name' } });
});

test('POST /vault/costs: at most 20 fixed costs, passed on; the database says who is an admin', async () => {
  const db = fakeDb({ 'bgc.costs_fixed_save': ([e, f]) => (e === 'owner@example.com' ? { ok: true, n: JSON.parse(f as string).length } : { ok: false, status: 403, message: 'Admins only' }) });
  const { app } = makeApp({ db });
  assert.deepEqual(await json(await post(app, '/vault/costs', { fixed: [] })), { status: 403, body: { ok: false, message: 'Admins only' } });
  const r = await app.request('/vault/costs', { method: 'POST', headers: { ...bearer(await token({ email: 'owner@example.com' })), 'Content-Type': 'application/json' }, body: JSON.stringify({ fixed: Array(30).fill({ name: 'x', amount: 1, per: 'month' }) }) });
  assert.deepEqual(await r.json(), { ok: true, n: 20 });
});
