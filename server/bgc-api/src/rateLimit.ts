// Per-member rate limit: a bucket of `perMinute` requests that refills steadily over a minute.
// Kept in memory: one container, and a restart simply gives everyone a full bucket.
import type { MiddlewareHandler } from 'hono';
import type { AuthEnv } from './auth.js';
import { ApiError } from './errors.js';

export function rateLimiter(perMinute: number, now: () => number = Date.now) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refillPerMs = perMinute / 60_000;
  const take = (key: string): { ok: boolean; retryAfter: number } => {
    const t = now();
    const b = buckets.get(key) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + (t - b.at) * refillPerMs);
    b.at = t;
    buckets.set(key, b);
    // Room: a bucket nobody has touched for a minute would be full again anyway, so it can go (its tokens aren't
    // refilled until it's touched, so looking at them would keep half-used idle ones forever)
    if (buckets.size > 5_000) for (const [k, v] of buckets) if (t - v.at > 60_000) buckets.delete(k);
    if (b.tokens >= 1) { b.tokens -= 1; return { ok: true, retryAfter: 0 }; }
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerMs / 1000) };
  };
  return Object.assign(take, { size: () => buckets.size }); // size: for the tests
}

// Keyed by the signed-in email, which the token check sets before this runs; the database hasn't been asked yet
export function perMember(take: ReturnType<typeof rateLimiter>): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const r = take(c.get('email'));
    if (!r.ok) {
      c.header('Retry-After', String(r.retryAfter));
      throw new ApiError(429, `That's a lot of requests at once. Try again in ${r.retryAfter} second${r.retryAfter === 1 ? '' : 's'}.`);
    }
    await next();
  };
}
