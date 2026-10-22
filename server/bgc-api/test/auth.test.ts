// The sign-in check: only a valid Google token for our client, from a member or the owner, gets in
import assert from 'node:assert/strict';
import { generateKeyPair } from 'jose';
import { test } from 'node:test';
import { bearer, get, makeApp, OWNER, token } from './helpers.js';

const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });

test('no token: 401 with a plain message, and the database is never asked', async () => {
  const { app, db } = makeApp();
  assert.deepEqual(await json(await get(app, '/vault/whoami')), { status: 401, body: { ok: false, message: 'Sign in to do that' } });
  assert.deepEqual(await json(await get(app, '/vault/whoami', { Authorization: 'Basic abc' })), { status: 401, body: { ok: false, message: 'Sign in to do that' } });
  assert.equal(db.calls.length, 0);
});

test('a member signs in as a friend, with their card', async () => {
  const { app, db } = makeApp();
  const r = await json(await get(app, '/vault/whoami', bearer(await token())));
  assert.deepEqual(r, { status: 200, body: { ok: true, role: 'friend', owner: false, playerId: 'recAmy', playerName: 'Amy', admin: false } });
  assert.deepEqual(db.calls[0], { sql: 'SELECT bgc.sign_in($1)', params: ['amy@example.com'] });
});

test('the owner is owner and admin; email case does not matter', async () => {
  const { app } = makeApp();
  const r = await json(await get(app, '/vault/whoami', bearer(await token({ email: OWNER.toUpperCase() }))));
  assert.equal(r.body.role, 'owner');
  assert.equal(r.body.admin, true);
});

test('a Google account that is not on the invite list can view only', async () => {
  const { app } = makeApp();
  const r = await json(await get(app, '/vault/whoami', bearer(await token({ email: 'stranger@example.com' }))));
  assert.deepEqual(r, { status: 401, body: { ok: false, message: 'This account can view only' } });
});

test('bad tokens are turned away before the database', async () => {
  const { app, db } = makeApp();
  const other = await generateKeyPair('RS256');
  const bad = [
    await token({}, { aud: 'someone-elses-client' }),             // another site's sign-in
    await token({}, { iss: 'https://evil.example.com' }),         // not from Google
    await token({}, { exp: Math.floor(Date.now() / 1000) - 120 }), // expired
    await token({ email_verified: false }),                        // unverified email
    await token({ email: undefined }),                             // no email
    await token({}, { key: other.privateKey }),                    // signed by someone else
  ];
  for (const t of bad) {
    const r = await json(await get(app, '/vault/whoami', bearer(t)));
    assert.equal(r.status, 401);
    assert.equal(r.body.message, 'Your sign-in has expired. Sign in again.');
  }
  assert.equal(db.calls.length, 0);
});

test('a database failure is a 500 with a plain message, not a stack trace', async () => {
  const { app } = makeApp({ db: (await import('./helpers.js')).fakeDb({ 'bgc.sign_in': () => { throw new Error('connection refused'); } }) });
  const orig = console.error; console.error = () => {};
  try {
    const r = await json(await get(app, '/vault/whoami', bearer(await token())));
    assert.deepEqual(r, { status: 500, body: { ok: false, message: 'Something went wrong on our side. Try again in a minute.' } });
  } finally { console.error = orig; }
});
