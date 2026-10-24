// The whole API as one Hono app. Built from its parts (database, token check, settings) so tests can swap them.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { memberGate, tokenGate, type AuthEnv, type VerifyToken } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ApiError, onError } from './errors.js';
import type { Fetch } from './http.js';
import { perMember, rateLimiter } from './rateLimit.js';
import { adminRoutes } from './routes/admin.js';
import { areaRoutes } from './routes/areas.js';
import { askRoutes } from './routes/ask.js';
import { bggRoutes } from './routes/bgg.js';
import { feedbackRoutes } from './routes/feedback.js';
import { nathanModeRoutes } from './routes/nathanMode.js';
import { profileRoutes } from './routes/profile.js';
import { rulebookRoutes } from './routes/rulebooks.js';
import { shelfRoutes } from './routes/shelves.js';
import { wishlistRoutes } from './routes/wishlist.js';

// now and signInCacheMs are for the tests: a clock to move, and how long a sign-in is remembered (0: never)
export type Deps = { db: Db; verify: VerifyToken; config: Config; now?: () => number; fetch?: Fetch; signInCacheMs?: number };

const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function createApp({ db, verify, config, now, fetch, signInCacheMs }: Deps) {
  const app = new Hono<AuthEnv>();
  app.onError(onError);
  app.notFound((c) => c.json({ ok: false, message: 'There’s nothing here' }, 404));

  // One line per request: route, status, time, member id. Never emails, questions or other content.
  app.use(async (c, next) => {
    const t = Date.now();
    await next();
    if (!config.logRequests || c.req.path === '/health') return;
    const a = c.get('auth');
    console.log(JSON.stringify({ at: new Date().toISOString(), method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - t, member: a?.memberId ?? null }));
  });

  // Only the site (and localhost while testing) may call from a browser
  app.use(cors({
    origin: (origin) => (config.allowedOrigins.includes(origin.toLowerCase()) || (config.allowLocalhost && LOCALHOST.test(origin)) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  }));
  // 1 MB, except a question to Nathan, which can carry a photo
  const tooBig = () => { throw new ApiError(413, 'That’s too big to send in one go'); };
  const small = bodyLimit({ maxSize: 1024 * 1024, onError: tooBig }), large = bodyLimit({ maxSize: 4 * 1024 * 1024, onError: tooBig });
  app.use((c, next) => (c.req.path.startsWith('/vault/ask') ? large : small)(c, next));

  // For Docker and the deploy script: up, and can reach the database
  app.get('/health', async (c) => {
    try { await db.ping(); return c.json({ ok: true, version: config.version }); }
    catch { return c.json({ ok: false, message: 'Can’t reach the database', version: config.version }, 503); }
  });

  // Everything under /vault is for signed-in members, each with their own rate limit. The limit comes right after the
  // token check and before the membership lookup (two database writes), so a flood of requests costs no database time.
  const vault = new Hono<AuthEnv>();
  vault.use(tokenGate(verify));
  vault.use(perMember(rateLimiter(config.ratePerMinute, now)));
  vault.use(memberGate({ db, ownerEmails: config.ownerEmails, cacheMs: signInCacheMs, now }));
  vault.route('/', profileRoutes(db));
  vault.route('/', shelfRoutes(db));
  vault.route('/', wishlistRoutes(db));
  vault.route('/', rulebookRoutes(db));
  vault.route('/', adminRoutes(db, { resendKey: config.resendKey, fetch }));
  vault.route('/', feedbackRoutes(db, { resendKey: config.resendKey, fetch, ownerEmail: config.ownerEmails[0] }));
  vault.route('/', bggRoutes({ db, bggToken: config.bggToken, fetch }));
  vault.route('/', areaRoutes(db, !!config.openrouterKey));
  vault.route('/', askRoutes(config.openrouterKey ? { db, openrouterKey: config.openrouterKey, bggToken: config.bggToken, fetch } : null));
  vault.route('/', nathanModeRoutes(db, !!config.openrouterKey));
  app.route('/vault', vault);

  return app;
}
