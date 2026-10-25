// The jobs worker (bgc-jobs): the same image as the API, started with `node dist/jobs/server.js`. Runs the schedules
// (what n8n's schedule triggers did) and takes work the API hands over. Nothing is published outside the Docker network.
//   GET  /health            up, and can reach the database
//   GET  /jobs              the jobs, their schedules, and the last 50 runs (job_runs)
//   POST /run/<name>        run a job now; the JSON body is its params. ?wait=1 answers with the result when it's done,
//                           otherwise as soon as it has started. 409 while that job is still running from before.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Bgg } from '../bgg.js';
import { loadConfig } from '../config.js';
import { pgDb } from '../db.js';
import { sendMail } from '../mail.js';
import { JOBS } from './index.js';
import { Runner } from './runner.js';
import type { JobCtx } from './types.js';

const config = loadConfig();
const db = pgDb(config.databaseUrl, { statementTimeoutMs: 120_000, max: 4 });
const ctx: JobCtx = { db, fetch, config, bgg: new Bgg(fetch, config.bggToken), mail: (m) => sendMail(fetch, config.resendKey, m) };
const runner = new Runner(ctx, JOBS, config.ownerEmails[0]);

const app = new Hono();
app.get('/health', async (c) => {
  try { await db.ping(); return c.json({ ok: true, version: config.version, running: runner.busy }); }
  catch { return c.json({ ok: false, message: 'Can’t reach the database' }, 503); }
});
app.get('/jobs', async (c) => c.json({ ok: true, jobs: runner.list(),
  runs: await db.rows('SELECT id, name, trigger, started_at, finished_at, ok, summary, error FROM job_runs ORDER BY started_at DESC LIMIT 50', []).catch(() => []) }));
app.post('/run/:name', async (c) => {
  const name = c.req.param('name');
  if (!runner.job(name)) return c.json({ ok: false, message: 'No job called ' + name }, 404);
  const params = await c.req.json().catch(() => ({}));
  const p = runner.run(name, params, 'api');
  if (c.req.query('wait') === '1') {
    const r = await p;
    return c.json({ ok: r.ok, result: r.result ?? null, error: r.error ?? null }, r.skipped === 'running' ? 409 : 200);
  }
  // Started (or refused as already running); the run goes on after this answer
  const started = await Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 50))]);
  if (started && started.skipped === 'running') return c.json({ ok: false, message: started.error }, 409);
  return c.json({ ok: true, started: true, ...(started ? { result: started.result ?? null } : {}) });
});

const server = serve({ fetch: app.fetch, port: config.jobsPort }, (info) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'bgc-jobs listening', port: info.port, version: config.version, tz: config.jobsTz, schedules: config.jobsSchedules })));
if (config.jobsSchedules) runner.start();

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'stopping', signal, running: runner.busy }));
  setTimeout(() => process.exit(0), 28_000).unref();
  server.close();
  runner.stop(25_000).then(() => db.close()).finally(() => process.exit(0));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('unhandledRejection', (e) => console.error(JSON.stringify({ level: 'error', where: 'unhandled', error: String((e as Error)?.stack || e) })));
