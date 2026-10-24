// One sign-in check for every route, in two steps with the rate limit between them (app.ts). The page sends
// "Authorization: Bearer <Google ID token>".
// 1. tokenGate: the token is checked with Google's public keys (fetched once and cached, so no call to Google per request):
//    signed by Google, for our client, not expired, email verified. Sets the email; the database isn't asked yet.
// 2. memberGate: bgc.sign_in(email) says whether they're a member (on the invite list), their role and card, and counts
//    the visit. Same outcome as addMemberAuth in n8n/gen.js: owner, friend (any member), or 401.
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { signIn, type Db } from './db.js';
import { ApiError } from './errors.js';

export type Auth = {
  role: 'owner' | 'friend';
  email: string;
  memberId: number | null;
  admin: boolean;
  playerId: string | null;
  playerName: string | null;
};
// email is set by tokenGate, auth by memberGate; routes only ever see both
export type AuthEnv = { Variables: { auth: Auth; email: string } };

export type VerifyToken = (token: string) => Promise<{ email: string }>;

const GOOGLE_KEYS = 'https://www.googleapis.com/oauth2/v3/certs';

export function googleVerifier(clientId: string, keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(GOOGLE_KEYS))): VerifyToken {
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer: ['accounts.google.com', 'https://accounts.google.com'],
      audience: clientId,
      algorithms: ['RS256'],
      clockTolerance: 30,
    });
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || payload.email_verified !== true) throw new Error('email not verified');
    return { email };
  };
}

// Whether a failed check means Google's keys couldn't be fetched (Google down, or our network) rather than a bad token:
// jose's timeout, its plain JOSEError for a key set that isn't 200 or isn't JSON, or fetch's own TypeError ("fetch
// failed": DNS, connection refused). Everything else (signature, audience, issuer, expiry, email) is the token's fault.
export function keysUnavailable(e: unknown): boolean {
  if (e instanceof errors.JWKSTimeout) return true;
  if (e instanceof errors.JOSEError) return e.code === 'ERR_JOSE_GENERIC';
  return e instanceof TypeError;
}

const Bearer = z.string().regex(/^Bearer [A-Za-z0-9_.-]{20,4096}$/);

export function tokenGate(verify: VerifyToken): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = Bearer.safeParse(c.req.header('authorization') ?? '');
    if (!header.success) throw new ApiError(401, 'Sign in to do that');
    try { c.set('email', (await verify(header.data.slice(7))).email); }
    catch (e) {
      if (!keysUnavailable(e)) throw new ApiError(401, 'Your sign-in has expired. Sign in again.');
      // Our problem, not theirs: say so (a 503, so the page doesn't sign them out) and log it, never the token
      console.error(JSON.stringify({ level: 'error', where: 'google keys', error: String((e as Error)?.message || e), cause: String((e as any)?.cause?.message ?? '') }));
      throw new ApiError(503, 'Can’t check your sign-in right now. Try again in a moment.');
    }
    await next();
  };
}

// The sign-in is remembered per email for a minute (cacheMs; 0 turns it off): tokens live an hour and the page asks
// several routes per screen, and the visit counter doesn't mind missing a minute's repeats. Only members and the owner
// are remembered, so someone Dan has just invited gets in on their next try.
export function memberGate(deps: { db: Db; ownerEmails: string[]; cacheMs?: number; now?: () => number }): MiddlewareHandler<AuthEnv> {
  const cacheMs = deps.cacheMs ?? 60_000, now = deps.now ?? Date.now;
  const known = new Map<string, { auth: Auth; at: number }>();
  return async (c, next) => {
    const email = c.get('email');
    const t = now();
    let hit = known.get(email);
    if (hit && t - hit.at > cacheMs) { known.delete(email); hit = undefined; }
    if (!hit) {
      const m = await signIn(deps.db, email);
      const owner = deps.ownerEmails.includes(email);
      const member = !!m && m.member === true;
      if (!owner && !member) throw new ApiError(401, 'This account can view only');
      hit = { at: t, auth: {
        role: owner ? 'owner' : 'friend',
        email,
        memberId: member ? m.id : null,
        admin: owner || (member && !!m.isAdmin),
        playerId: member ? m.playerId ?? null : null,
        playerName: member ? m.playerName ?? null : null,
      } };
      if (cacheMs > 0) {
        known.set(email, hit);
        if (known.size > 1_000) for (const [k, v] of known) if (t - v.at > cacheMs) known.delete(k);
      }
    }
    c.set('auth', hit.auth);
    await next();
  };
}
