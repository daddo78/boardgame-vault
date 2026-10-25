// Runs jobs: on request, and on their schedules. Every run is a row in job_runs (what n8n's execution list showed),
// and a failed run emails Dan, at most once per job per 30 minutes, as the old Error Alert workflow did.
import { clock, isDue, type LastRun } from './schedule.js';
import type { Job, JobCtx } from './types.js';

export type RunResult = { ok: boolean; result?: unknown; error?: string; skipped?: 'running' | 'unknown' };

export class Runner {
  private running = new Map<string, Promise<RunResult>>();
  private last = new Map<string, LastRun>();
  private lastAlert = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private ctx: JobCtx, private jobs: Job[], private alertTo: string | undefined) {}

  job(name: string) { return this.jobs.find((j) => j.name === name); }
  list() { return this.jobs.map((j) => ({ name: j.name, schedule: j.schedule ?? null, running: this.running.has(j.name) })); }

  // One run of a job. A job that mustn't overlap itself is skipped while its last run is still going.
  async run(name: string, params: unknown, trigger: string): Promise<RunResult> {
    const job = this.job(name);
    if (!job) return { ok: false, skipped: 'unknown', error: 'No job called ' + name };
    if (!job.concurrent && this.running.has(name)) return { ok: false, skipped: 'running', error: name + ' is already running' };
    const p = this.execute(job, params, trigger);
    if (!job.concurrent) { this.running.set(name, p); p.finally(() => { if (this.running.get(name) === p) this.running.delete(name); }); }
    return p;
  }

  private async execute(job: Job, params: unknown, trigger: string): Promise<RunResult> {
    const { db } = this.ctx;
    const t0 = Date.now();
    const id = await db.one<number>('INSERT INTO job_runs (name, trigger) VALUES ($1, $2) RETURNING id', [job.name, trigger]).catch(() => null);
    const log = (extra: object) => console.log(JSON.stringify({ at: new Date().toISOString(), job: job.name, trigger, ...extra }));
    try {
      const result = await job.run(this.ctx, params ?? {});
      log({ ok: true, ms: Date.now() - t0 });
      if (id != null) await db.one('UPDATE job_runs SET finished_at = now(), ok = true, summary = $2::jsonb WHERE id = $1', [id, JSON.stringify(result ?? null)]).catch(() => null);
      return { ok: true, result };
    } catch (e) {
      const error = String((e as Error)?.stack || (e as Error)?.message || e).slice(0, 2000);
      log({ ok: false, ms: Date.now() - t0, error: error.split('\n')[0] });
      if (id != null) await db.one('UPDATE job_runs SET finished_at = now(), ok = false, error = $2 WHERE id = $1', [id, error]).catch(() => null);
      await this.alert(job.name, error.split('\n')[0], trigger);
      return { ok: false, error: error.split('\n')[0] };
    }
  }

  // Email Dan about a failed run, once per job per 30 minutes
  private async alert(name: string, error: string, trigger: string) {
    if (!this.alertTo) return;
    const at = this.lastAlert.get(name) || 0;
    if (Date.now() - at < 30 * 60 * 1000) return;
    this.lastAlert.set(name, Date.now());
    await this.ctx.mail({ to: this.alertTo, subject: `Board Game Curator: "${name}" failed`, text: [
      'Something went wrong in Board Game Curator.', '',
      'Job: ' + name + ' (' + trigger + ')',
      'Error: ' + error,
      'When: ' + new Date().toISOString(), '',
      'Recent runs: Admin → Dashboard, or SELECT * FROM job_runs ORDER BY started_at DESC on the server.',
      '', '(More failures from this job in the next 30 minutes will not send another email.)',
    ].join('\n') });
  }

  // The schedules: a look every 30 seconds at what's due
  tick(now = new Date()) {
    const c = clock(now, this.ctx.config.jobsTz);
    for (const job of this.jobs) {
      if (!job.schedule || this.running.has(job.name) || !isDue(job.schedule, c, this.last.get(job.name) ?? null)) continue;
      this.last.set(job.name, c);
      void this.run(job.name, {}, 'schedule');
    }
  }
  start() { if (!this.timer) { this.tick(); this.timer = setInterval(() => this.tick(), 30_000); } }
  // Stop taking schedules and wait (up to graceMs) for what's running
  async stop(graceMs = 25_000) {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await Promise.race([Promise.allSettled([...this.running.values()]), new Promise((r) => setTimeout(r, graceMs))]);
  }
  get busy() { return [...this.running.keys()]; }
}
