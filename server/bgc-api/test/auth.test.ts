// The sign-in check: only a valid Google token for our client, from a member or the owner, gets in
import assert from 'node:assert/strict';
import { errors, generateKeyPair } from 'jose';
import { test } from 'node:test';
import { bearer, fakeDb, get, makeApp, OWNER, token } from './helpers.js';

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
  const { app } = makeApp({ db: fakeDb({ 'bgc.sign_in': () => { throw new Error('connection refused'); } }) });
  const orig = console.error; console.error = () => {};
  try {
    const r = await json(await get(app, '/vault/whoami', bearer(await token())));
    assert.deepEqual(r, { status: 500, body: { ok: false, message: 'Something went wrong on our side. Try again in a minute.' } });
  } finally { console.error = orig; }
});

test('Google’s keys out of reach: a 503 asking to try again (not “sign in again”), one log line without the token', async () => {
  const lines: string[] = [];
  const orig = console.error; console.error = (s: unknown) => { lines.push(String(s)); };
  try {
    const outages = [
      new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND www.googleapis.com') }), // no network
      new errors.JWKSTimeout(),                                                                        // Google slow
      new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'),                 // Google 5xx
    ];
    for (const outage of outages) {
      const { app, db } = makeApp({ keys: async () => { throw outage; } });
      const t = await token();
      const r = await json(await get(app, '/vault/whoami', bearer(t)));
      assert.deepEqual(r, { status: 503, body: { ok: false, message: 'Can’t check your sign-in right now. Try again in a moment.' } }, outage.message);
      assert.equal(db.calls.length, 0);
    }
    assert.equal(lines.length, outages.length);
    for (const l of lines) { JSON.parse(l); assert.ok(!l.includes('eyJ'), 'no token in the log'); }
    // A key set that simply has no key for this token is the token's fault
    const { app } = makeApp({ keys: async () => { throw new errors.JWKSNoMatchingKey(); } });
    assert.equal((await get(app, '/vault/whoami', bearer(await token()))).status, 401);
  } finally { console.error = orig; }
});

test('a sign-in is remembered for a minute (members only); the rate limit comes before the database', async () => {
  let now = 1_000_000;
  const { app, db } = makeApp({ now: () => now });
  const amy = bearer(await token());
  const signIns = () => db.calls.filter((c) => c.sql.includes('bgc.sign_in')).length;
  await get(app, '/vault/whoami', amy); await get(app, '/vault/me', amy);
  assert.equal(signIns(), 1);
  now += 61_000;
  await get(app, '/vault/whoami', amy);
  assert.equal(signIns(), 2, 'asked again after a minute');
  // Someone not on the list isn't remembered: invited a moment later, they get in on their next try
  const stranger = bearer(await token({ email: 'stranger@example.com' }));
  await get(app, '/vault/whoami', stranger); await get(app, '/vault/whoami', stranger);
  assert.equal(signIns(), 4);
  // Over the limit: turned away before bgc.sign_in is called (cache off, so every allowed request shows as one call)
  const fresh = makeApp({ env: { RATE_PER_MINUTE: '2' }, now: () => now, signInCacheMs: 0 });
  for (let i = 0; i < 3; i++) await get(fresh.app, '/vault/whoami', amy);
  assert.equal(fresh.db.calls.filter((c) => c.sql.includes('bgc.sign_in')).length, 2);
});
