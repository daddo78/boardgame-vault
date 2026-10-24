// Routes, input checks, CORS, rate limits and health
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rateLimiter } from '../src/rateLimit.js';
import { bearer, fakeDb, get, makeApp, token } from './helpers.js';

const json = async (r: Response) => ({ status: r.status, body: await r.json() as any });

test('GET /vault/me: the signed-in member’s own profile from bgc.my_profile', async () => {
  const { app, db } = makeApp();
  const r = await json(await get(app, '/vault/me', bearer(await token())));
  assert.deepEqual(r, { status: 200, body: { ok: true, profile: { name: 'Amy', likes: 'co-op' } } });
  assert.deepEqual(db.calls.at(-1), { sql: 'SELECT bgc.my_profile($1)', params: ['amy@example.com'] });
});

test('GET /vault/profile: own, a friend’s, and the database’s “not friends” answer passed on', async () => {
  const { app, db } = makeApp();
  const t = bearer(await token());
  assert.deepEqual((await json(await get(app, '/vault/profile', t))).body, { ok: true, id: 7, self: true });
  assert.deepEqual(db.calls.at(-1)!.params, ['amy@example.com', null]);
  assert.deepEqual((await json(await get(app, '/vault/profile?friend=', t))).body.self, true);
  assert.deepEqual((await json(await get(app, '/vault/profile?friend=12', t))).body, { ok: true, id: 12, self: false });
  assert.deepEqual(db.calls.at(-1)!.params, ['amy@example.com', 12]);
  assert.deepEqual(await json(await get(app, '/vault/profile?friend=99', t)),
    { status: 403, body: { ok: false, message: 'You can see a profile once you’re friends' } });
});

test('GET /vault/profile: bad input is a 400 and never reaches the database', async () => {
  const { app, db } = makeApp();
  const t = bearer(await token());
  for (const q of ['abc', '-3', '1.5', '0', '1e400', "1;DROP TABLE members"]) {
    const before = db.calls.filter((c) => c.sql.includes('profile_page')).length;
    const r = await json(await get(app, '/vault/profile?friend=' + encodeURIComponent(q), t));
    assert.deepEqual(r, { status: 400, body: { ok: false, message: 'That profile link doesn’t look right' } }, q);
    assert.equal(db.calls.filter((c) => c.sql.includes('profile_page')).length, before, q);
  }
});

test('unknown routes: a plain 404', async () => {
  const { app } = makeApp();
  assert.deepEqual(await json(await get(app, '/nope')), { status: 404, body: { ok: false, message: 'There’s nothing here' } });
});

test('CORS: the site and localhost may call from a browser; other sites may not', async () => {
  const { app } = makeApp();
  const pre = (origin: string) => app.request('/vault/me', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal((await pre('https://bg.ondorilabo.com')).headers.get('access-control-allow-origin'), 'https://bg.ondorilabo.com');
  assert.equal((await pre('http://localhost:5500')).headers.get('access-control-allow-origin'), 'http://localhost:5500');
  assert.equal((await pre('https://evil.example.com')).headers.get('access-control-allow-origin'), null);
  assert.equal((await pre('https://bg.ondorilabo.com.evil.com')).headers.get('access-control-allow-origin'), null);
  const { app: prod } = makeApp({ env: { ALLOW_LOCALHOST: 'false' } });
  const r = await prod.request('/health', { headers: { Origin: 'http://localhost:5500' } });
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('rate limit: each member gets their own bucket; over it is a 429 with Retry-After', async () => {
  let now = 1_000_000;
  const { app } = makeApp({ env: { RATE_PER_MINUTE: '3' }, now: () => now });
  const amy = bearer(await token());
  const dan = bearer(await token({ email: 'owner@example.com' }));
  for (let i = 0; i < 3; i++) assert.equal((await get(app, '/vault/whoami', amy)).status, 200);
  const r = await get(app, '/vault/whoami', amy);
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '20');
  assert.match((await r.json() as any).message, /Try again in 20 seconds/);
  assert.equal((await get(app, '/vault/whoami', dan)).status, 200); // Dan isn't slowed by Amy
  now += 20_000;
  assert.equal((await get(app, '/vault/whoami', amy)).status, 200); // refilled
});

test('rate limiter: buckets idle for a minute are dropped, even half-used ones; a busy one stays', () => {
  let now = 0;
  const take = rateLimiter(10, () => now);
  for (let i = 0; i < 5_001; i++) take('idle' + i); // each one request down: never "full" again until touched
  now += 30_000; take('busy');
  now += 31_000; take('new');                      // the idle ones are 61 s old, busy 31 s
  assert.equal(take.size(), 2);
});

test('/health: ok while the database answers, 503 when it does not; no sign-in needed', async () => {
  const db = fakeDb();
  const { app } = makeApp({ db, env: { VERSION: 'abc123' } });
  assert.deepEqual(await json(await get(app, '/health')), { status: 200, body: { ok: true, version: 'abc123' } });
  db.down();
  assert.deepEqual(await json(await get(app, '/health')), { status: 503, body: { ok: false, message: 'Can’t reach the database', version: 'abc123' } });
});

test('settings: a missing database address stops the service at start, with a plain reason', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.throws(() => loadConfig({}), /DATABASE_URL or PGHOST/);
  assert.equal(loadConfig({ PGHOST: 'bgc-postgres' }).databaseUrl, undefined);
  assert.throws(() => loadConfig({ PGHOST: 'x', RATE_PER_MINUTE: 'lots' }), /RATE_PER_MINUTE/);
  assert.equal(loadConfig({ PGHOST: 'x' }).allowLocalhost, false, 'the server never sets ALLOW_LOCALHOST, so only the site may call');
});
