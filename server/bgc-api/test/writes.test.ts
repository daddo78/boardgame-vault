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
