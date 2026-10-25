// Test kit: real signed tokens from a stand-in "Google" key, and a stand-in database that answers the bgc.* calls
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import { createApp } from '../src/app.js';
import { googleVerifier } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { Db } from '../src/db.js';
import type { JobsClient } from '../src/jobsClient.js';

export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const OWNER = 'owner@example.com';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const googleKeys = createLocalJWKSet({ keys: [jwk] });

export async function token(claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string; exp?: string | number; key?: CryptoKey } = {}) {
  return new SignJWT({ email: 'amy@example.com', email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '1h')
    .sign(opts.key ?? privateKey);
}

// Members on the invite list, as bgc.sign_in would answer for them
export const MEMBERS: Record<string, { id: number; name: string; isAdmin: boolean; playerId: string | null; playerName: string | null }> = {
  'amy@example.com': { id: 7, name: 'Amy', isAdmin: false, playerId: 'recAmy', playerName: 'Amy' },
  [OWNER]: { id: 1, name: 'Dan', isAdmin: true, playerId: null, playerName: 'Dan' },
};

export function fakeDb(overrides: Partial<Record<string, (params: unknown[]) => unknown>> = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const answers: Record<string, (p: unknown[]) => unknown> = {
    'bgc.sign_in': ([email]) => (MEMBERS[email as string] ? { member: true, ...MEMBERS[email as string] } : { member: false }),
    'bgc.my_profile': ([email]) => ({ name: MEMBERS[email as string]?.name, likes: 'co-op' }),
    'bgc.profile_page': ([email, friend]) => (friend === 99
      ? { ok: false, status: 403, message: 'You can see a profile once you’re friends' }
      : { ok: true, id: friend ?? MEMBERS[email as string]?.id, self: friend == null }),
    ...overrides,
  };
  let up = true;
  const db: Db & { calls: typeof calls; down(): void } = {
    calls,
    down() { up = false; },
    async one<T>(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const fn = Object.keys(answers).find((k) => sql.includes(k + '(')) ?? Object.keys(answers).find((k) => sql.includes(k));
      if (!fn) throw new Error('fake db: no answer for ' + sql);
      return (await answers[fn](params)) as T;
    },
    // Nathan's steps read rows; his tests (nathan.test.ts) put their own row() in place of this one
    async row() { throw new Error('fake db: no row answers here'); },
    // Several rows (the jobs): answered like one(), an array expected; nothing known is no rows
    async rows<T>(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const fn = Object.keys(answers).find((k) => sql.includes(k + '(')) ?? Object.keys(answers).find((k) => sql.includes(k));
      const out = fn ? await answers[fn](params) : [];
      return (Array.isArray(out) ? out : []) as T[];
    },
    async ping() { if (!up) throw new Error('down'); },
    async close() {},
  };
  return db;
}

// A jobs worker that takes everything and does nothing, so no test runs a background job by accident. Tests that care
// hand in their own (fakeJobs) and look at what was handed over.
export function fakeJobs(results: Record<string, unknown> = {}) {
  const runs: { name: string; params: unknown; wait: boolean }[] = [];
  const jobs: JobsClient & { runs: typeof runs } = { runs, async run(name, params, opts = {}) { runs.push({ name, params, wait: !!opts.wait }); return { where: 'worker', result: results[name] }; } };
  return jobs;
}
const noJobs = fakeJobs();

// Settings as the tests run: localhost allowed (the page on this computer), as `npm run dev` also wants
const ENV = { DATABASE_URL: 'postgres://unused', GOOGLE_CLIENT_ID: CLIENT_ID, OWNER_EMAILS: OWNER, LOG_REQUESTS: 'false', ALLOW_LOCALHOST: 'true' };

// keys: in place of Google's key set (to make fetching it fail); signInCacheMs: how long a sign-in is remembered (0: never)
export function makeApp(opts: { db?: ReturnType<typeof fakeDb>; env?: Record<string, string>; now?: () => number; keys?: JWTVerifyGetKey; signInCacheMs?: number; fetch?: typeof fetch; jobs?: JobsClient } = {}) {
  const db = opts.db ?? fakeDb();
  const config = loadConfig({ ...ENV, ...opts.env });
  const app = createApp({ db, verify: googleVerifier(CLIENT_ID, opts.keys ?? googleKeys), config, now: opts.now, signInCacheMs: opts.signInCacheMs, fetch: opts.fetch, jobs: opts.jobs ?? noJobs, bggGapMs: 0 });
  return { app, db };
}

// With Nathan: a stand-in OpenRouter (fetch) and his settings
export function makeAppWith(opts: { db: Db; fetch: typeof fetch; env?: Record<string, string>; jobs?: JobsClient }) {
  const config = loadConfig({ ...ENV, OPENROUTER_API_KEY: 'sk-test', ...opts.env });
  return createApp({ db: opts.db, verify: googleVerifier(CLIENT_ID, googleKeys), config, fetch: opts.fetch, jobs: opts.jobs ?? noJobs, bggGapMs: 0 });
}

export const get = (app: ReturnType<typeof makeApp>['app'], path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });
export const bearer = (t: string) => ({ Authorization: 'Bearer ' + t });
