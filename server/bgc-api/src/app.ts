// The whole API as one Hono app. Built from its parts (database, token check, settings) so tests can swap them.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { memberGate, tokenGate, type AuthEnv, type VerifyToken } from './auth.js';
import { Bgg } from './bgg.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { ApiError, onError } from './errors.js';
import type { Fetch } from './http.js';
import { JOBS } from './jobs/index.js';
import type { JobCtx } from './jobs/types.js';
import { jobsClient, localRunner, type JobsClient } from './jobsClient.js';
import { sendMail } from './mail.js';
import { perMember, rateLimiter } from './rateLimit.js';
import { adminRoutes } from './routes/admin.js';
import { areaRoutes } from './routes/areas.js';
import { askRoutes } from './routes/ask.js';
import { bggRoutes } from './routes/bgg.js';
import { feedbackRoutes } from './routes/feedback.js';
import { importRoutes } from './routes/imports.js';
import { nathanModeRoutes } from './routes/nathanMode.js';
import { profileRoutes } from './routes/profile.js';
import { rulebookUploadRoutes } from './routes/rulebookUpload.js';
import { rulebookRoutes } from './routes/rulebooks.js';
import { shelfPhotoRoutes } from './routes/shelfPhoto.js';
import { shelfRoutes } from './routes/shelves.js';
import { wishlistRoutes } from './routes/wishlist.js';

// now and signInCacheMs are for the tests: a clock to move, and how long a sign-in is remembered (0: never).
// jobs: where background work goes (tests hand in a stand-in); bggGapMs: the pause between BGG requests (tests: 0)
export type Deps = { db: Db; verify: VerifyToken; config: Config; now?: () => number; fetch?: Fetch; signInCacheMs?: number; jobs?: JobsClient; bggGapMs?: number };

const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MB = 1024 * 1024;
// How big a request may be: a rulebook PDF (60 MB, the page's own limit), a photo, a question to Nathan with a photo, the rest
const limitFor = (path: string) => path === '/vault/rulebook' ? 64 * MB : path === '/vault/shelf-identify' ? 8 * MB : path.startsWith('/vault/ask') ? 4 * MB : 1 * MB;

export function createApp({ db, verify, config, now, fetch: f0, signInCacheMs, jobs, bggGapMs }: Deps) {
  const f: Fetch = f0 ?? fetch;
  const bgg = new Bgg(f, config.bggToken, bggGapMs ?? 1000);
  const ctx: JobCtx = { db, fetch: f, config, bgg, mail: (m) => sendMail(f, config.resendKey, m) };
  const jobsC = jobs ?? jobsClient(config, f, localRunner(ctx, JOBS));

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
  const tooBig = () => { throw new ApiError(413, 'That’s too big to send in one go'); };
  app.use((c, next) => bodyLimit({ maxSize: limitFor(c.req.path), onError: tooBig })(c, next));

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
  vault.route('/', rulebookUploadRoutes(db, { pagesUrl: config.pagesUrl, fetch: f, jobs: jobsC }));
  vault.route('/', adminRoutes(db, { resendKey: config.resendKey, fetch: f }));
  vault.route('/', feedbackRoutes(db, { resendKey: config.resendKey, fetch: f, ownerEmail: config.ownerEmails[0] }));
  vault.route('/', bggRoutes({ db, bggToken: config.bggToken, openrouterKey: config.openrouterKey, fetch: f }));
  vault.route('/', shelfPhotoRoutes({ db, bgg, openrouterKey: config.openrouterKey, fetch: f, config }));
  vault.route('/', importRoutes(db, jobsC));
  vault.route('/', areaRoutes(db, !!config.openrouterKey));
  vault.route('/', askRoutes(config.openrouterKey ? { db, openrouterKey: config.openrouterKey, bggToken: config.bggToken, fetch: f } : null));
  vault.route('/', nathanModeRoutes(db, !!config.openrouterKey));
  app.route('/vault', vault);

  return app;
}
