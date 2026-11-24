// The site's own sign-in sessions (schema/061_sessions.sql). Google is asked once: POST /vault/session takes a Google ID
// token, and the answer sets a session cookie the browser sends with every request after that. The cookie is
//   __Host-  only ever from api.ondorilabo.com itself, over HTTPS, for every path (no other subdomain can set or read it)
//   HttpOnly the page's scripts can't read it, so even a script injected into the page couldn't take it away
//   SameSite=Lax  other sites' pages can't send it with their requests
// and it lasts SESSION_DAYS (60) without use; using it pushes that out, at most once a day (Safari keeps a cookie from a
// server on another address only 7 days unless it's set again, so it is set again on that daily renewal).
// The database keeps only a SHA-256 hash of each token.
// Every request that signs in with the cookie must also carry "X-BGC: 1". A page on another site can't add that header
// without the browser first asking this API (CORS), which answers only the site: one more wall against forged requests.
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Db } from './db.js';

export const SESSION_COOKIE = '__Host-bgc_session';
export const SITE_HEADER = 'X-BGC';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const Shape = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export type Sessions = {
  days: number;
  start(email: string): Promise<string>;
  check(token: string): Promise<{ email: string; renewed: boolean } | null>;
  end(token: string): Promise<void>;
};

// cacheMs: how long a checked session is remembered here (tests: 0), like memberGate's sign-in. A signed-out session
// is forgotten at once; one that merely expires is caught on the next database check.
export function sessionStore(db: Db, opts: { days: number; cacheMs?: number; now?: () => number }): Sessions {
  const cacheMs = opts.cacheMs ?? 60_000, now = opts.now ?? Date.now;
  const known = new Map<string, { email: string; at: number }>();
  return {
    days: opts.days,
    async start(email) {
      const token = randomBytes(32).toString('base64url');
      await db.one('SELECT bgc.session_start($1, $2, $3)', [email, hash(token), opts.days]);
      return token;
    },
    async check(token) {
      if (!Shape.test(token)) return null;
      const h = hash(token), t = now();
      const hit = known.get(h);
      if (hit && t - hit.at <= cacheMs) return { email: hit.email, renewed: false };
      known.delete(h);
      const s = await db.one<{ email: string; renewed: boolean }>('SELECT bgc.session_check($1, $2)', [h, opts.days]);
      if (!s) return null;
      if (cacheMs > 0) {
        known.set(h, { email: s.email, at: t });
        if (known.size > 1_000) for (const [k, v] of known) if (t - v.at > cacheMs) known.delete(k);
      }
      return { email: s.email, renewed: !!s.renewed };
    },
    async end(token) {
      if (!Shape.test(token)) return;
      const h = hash(token);
      known.delete(h);
      await db.one('SELECT bgc.session_end($1)', [h]);
    },
  };
}

export const sessionCookie = (c: Context) => getCookie(c, SESSION_COOKIE);
export function setSessionCookie(c: Context, token: string, days: number) {
  setCookie(c, SESSION_COOKIE, token, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax', maxAge: days * 86_400 });
}
export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' });
}
export const fromSite = (c: Context) => c.req.header(SITE_HEADER) === '1';
