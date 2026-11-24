// The site's own sessions: Google once (POST /vault/session), then a cookie the page's scripts can't read
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bearer, fakeDb, makeApp, token } from './helpers.js';

const SITE = { 'X-BGC': '1' };
const COOKIE = '__Host-bgc_session';

// bgc.session_* as the database answers them (061), kept in a Map
function sessionDb(opts: { renewed?: boolean } = {}) {
  const rows = new Map<string, string>();
  const db = fakeDb({
    'bgc.session_start': ([email, hash]) => { rows.set(hash as string, (email as string).toLowerCase()); return null; },
    'bgc.session_check': ([hash]) => (rows.has(hash as string) ? { email: rows.get(hash as string), renewed: !!opts.renewed } : null),
    'bgc.session_end': ([hash]) => { rows.delete(hash as string); return null; },
  });
  return Object.assign(db, { rows });
}
const cookieOf = (r: Response) => {
  const h = r.headers.get('set-cookie') ?? '';
  const m = h.match(new RegExp(COOKIE + '=([^;]*)'));
  return { header: h, value: m ? m[1] : null };
};
async function signIn(app: ReturnType<typeof makeApp>['app'], claims: Record<string, unknown> = {}) {
  return app.request('/vault/session', { method: 'POST', headers: { ...SITE, ...bearer(await token(claims)) } });
}
const withCookie = (v: string, site = true) => ({ Cookie: `${COOKIE}=${v}`, ...(site ? SITE : {}) });

test('signing in with Google starts a session: an HttpOnly cookie for 60 days, and only its hash is stored', async () => {
  const db = sessionDb();
  const { app } = makeApp({ db, signInCacheMs: 0 });
  const r = await signIn(app);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, role: 'friend', owner: false, playerId: 'recAmy', playerName: 'Amy', admin: false });
  const c = cookieOf(r);
  assert.match(c.value ?? '', /^[A-Za-z0-9_-]{43}$/);
  for (const part of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=5184000']) assert.ok(c.header.includes(part), part);
  assert.ok(!/Domain=/i.test(c.header), 'no Domain: only api.ondorilabo.com gets it');
  const start = db.calls.find((x) => x.sql.includes('bgc.session_start'))!;
  assert.equal(start.params[0], 'amy@example.com');
  assert.match(start.params[1] as string, /^[0-9a-f]{64}$/);
  assert.notEqual(start.params[1], c.value);
  assert.equal(start.params[2], 60);
});

test('the cookie signs in on every route, no Google token needed', async () => {
  const db = sessionDb();
  const { app } = makeApp({ db, signInCacheMs: 0 });
  const { value } = cookieOf(await signIn(app));
  const r = await app.request('/vault/whoami', { headers: withCookie(value!) });
  assert.equal(r.status, 200);
  assert.equal((await r.json() as any).playerName, 'Amy');
  assert.equal(r.headers.get('set-cookie'), null, 'not renewed on every request');
});

test('the cookie alone, without the site header, is refused before the database (a forged request from another site)', async () => {
  const db = sessionDb();
  const { app } = makeApp({ db, signInCacheMs: 0 });
  const { value } = cookieOf(await signIn(app));
  const before = db.calls.length;
  const r = await app.request('/vault/whoami', { headers: withCookie(value!, false) });
  assert.equal(r.status, 403);
  assert.equal(db.calls.length, before);
  const s = await app.request('/vault/session', { method: 'POST', headers: bearer(await token()) });
  assert.equal(s.status, 403);
});

test('an unknown or ended session is a 401 that clears the cookie', async () => {
  const db = sessionDb();
  const { app } = makeApp({ db, signInCacheMs: 0 });
  for (const v of ['x'.repeat(43), 'not-a-token']) {
    const r = await app.request('/vault/whoami', { headers: withCookie(v) });
    assert.equal(r.status, 401);
    assert.equal((await r.json() as any).message, 'Your sign-in has expired. Sign in again.');
    assert.match(cookieOf(r).header, /Max-Age=0/);
  }
  assert.ok(!db.calls.some((x) => x.params.includes('not-a-token')), 'a malformed cookie never reaches the database');
});

test('signing out ends the session, so a copy of the cookie stops working', async () => {
  const db = sessionDb();
  const { app } = makeApp({ db, signInCacheMs: 0 });
  const { value } = cookieOf(await signIn(app));
  const out = await app.request('/vault/session/end', { method: 'POST', headers: withCookie(value!) });
  assert.equal(out.status, 200);
  assert.match(cookieOf(out).header, /Max-Age=0/);
  assert.equal(db.rows.size, 0);
  assert.equal((await app.request('/vault/whoami', { headers: withCookie(value!) })).status, 401);
  assert.equal((await app.request('/vault/session/end', { method: 'POST', headers: { Cookie: `${COOKIE}=${value}` } })).status, 403);
});

test('signing in again in the same browser replaces its session', async () => {
  const db = sessionDb();
  const { app } = makeApp({ db, signInCacheMs: 0 });
  const first = cookieOf(await signIn(app)).value!;
  const again = await app.request('/vault/session', { method: 'POST', headers: { ...withCookie(first), ...bearer(await token()) } });
  assert.equal(again.status, 200);
  assert.equal(db.rows.size, 1);
  assert.notEqual(cookieOf(again).value, first);
});

test('someone not on the invite list gets no session', async () => {
  const db = sessionDb();
  const { app } = makeApp({ db, signInCacheMs: 0 });
  const r = await signIn(app, { email: 'stranger@example.com' });
  assert.equal(r.status, 401);
  assert.equal(cookieOf(r).value, null);
  assert.equal(db.rows.size, 0);
});

test('a session is renewed (the cookie sent again for 60 days) when the database says so', async () => {
  const db = sessionDb({ renewed: true });
  const { app } = makeApp({ db, signInCacheMs: 0 });
  const { value } = cookieOf(await signIn(app));
  const r = await app.request('/vault/whoami', { headers: withCookie(value!) });
  assert.equal(r.status, 200);
  const c = cookieOf(r);
  assert.equal(c.value, value);
  assert.match(c.header, /Max-Age=5184000/);
});

test('a session is checked once a minute, not on every request, and signing out forgets it at once', async () => {
  const db = sessionDb();
  let t = 1_000_000;
  const { app } = makeApp({ db, now: () => t });
  const { value } = cookieOf(await signIn(app));
  const checks = () => db.calls.filter((x) => x.sql.includes('bgc.session_check')).length;
  await app.request('/vault/whoami', { headers: withCookie(value!) });
  await app.request('/vault/whoami', { headers: withCookie(value!) });
  assert.equal(checks(), 1);
  t += 61_000;
  await app.request('/vault/whoami', { headers: withCookie(value!) });
  assert.equal(checks(), 2);
  await app.request('/vault/session/end', { method: 'POST', headers: withCookie(value!) });
  assert.equal((await app.request('/vault/whoami', { headers: withCookie(value!) })).status, 401);
});

test('a Google token still works on its own (Admin before it signs in again, scripts)', async () => {
  const { app } = makeApp({ db: sessionDb(), signInCacheMs: 0 });
  assert.equal((await app.request('/vault/whoami', { headers: bearer(await token()) })).status, 200);
});

test('CORS: the site may send its cookie and the X-BGC header; other sites may not', async () => {
  const { app } = makeApp();
  const pre = (origin: string) => app.request('/vault/whoami', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-bgc' } });
  const ok = await pre('https://bg.ondorilabo.com');
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://bg.ondorilabo.com');
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.match(ok.headers.get('access-control-allow-headers') ?? '', /X-BGC/i);
  const bad = await pre('https://evil.example.com');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
});
