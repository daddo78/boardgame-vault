// One sign-in check for every route. The page sends "Authorization: Bearer <Google ID token>".
// 1. The token is checked here with Google's public keys (fetched once and cached, so no call to Google per request):
//    signed by Google, for our client, not expired, email verified.
// 2. bgc.sign_in(email) says whether they're a member (on the invite list), their role and card, and counts the visit.
// Same outcome as addMemberAuth in n8n/gen.js: owner, friend (any member), or 401.
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
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
export type AuthEnv = { Variables: { auth: Auth } };

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

const Bearer = z.string().regex(/^Bearer [A-Za-z0-9_.-]{20,4096}$/);

export function memberGate(deps: { db: Db; verify: VerifyToken; ownerEmails: string[] }): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const header = Bearer.safeParse(c.req.header('authorization') ?? '');
    if (!header.success) throw new ApiError(401, 'Sign in to do that');
    let email: string;
    try { ({ email } = await deps.verify(header.data.slice(7))); }
    catch { throw new ApiError(401, 'Your sign-in has expired. Sign in again.'); }
    const m = await signIn(deps.db, email);
    const owner = deps.ownerEmails.includes(email);
    const member = !!m && m.member === true;
    if (!owner && !member) throw new ApiError(401, 'This account can view only');
    c.set('auth', {
      role: owner ? 'owner' : 'friend',
      email,
      memberId: member ? m.id : null,
      admin: owner || (member && !!m.isAdmin),
      playerId: member ? m.playerId ?? null : null,
      playerName: member ? m.playerName ?? null : null,
    });
    await next();
  };
}
