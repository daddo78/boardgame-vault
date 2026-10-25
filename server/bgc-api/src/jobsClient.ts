// Handing background work to the jobs worker (bgc-jobs): a BGG import, a spreadsheet of games, reading a rulebook,
// an on-demand play sync. The worker answers POST /run/<job> on the Docker network; nothing is published outside.
// Without a worker (tests, `npm run dev`), the same job function runs here, so the API is whole on its own.
import type { Config } from './config.js';
import type { Fetch } from './http.js';
import type { JobCtx } from './jobs/types.js';

export type RunLocal = (name: string, params: unknown) => Promise<unknown>;
export type JobsClient = {
  // wait: the job's result is wanted (an on-demand sync); otherwise the hand-off returns as soon as the worker took it
  run(name: string, params: unknown, opts?: { wait?: boolean }): Promise<{ where: 'worker' | 'here'; result?: unknown }>;
};

export function jobsClient(config: Pick<Config, 'jobsUrl'>, f: Fetch, local: RunLocal): JobsClient {
  return {
    async run(name, params, opts = {}) {
      if (config.jobsUrl) {
        try {
          const r = await f(config.jobsUrl + '/run/' + encodeURIComponent(name) + (opts.wait ? '?wait=1' : ''), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params ?? {}),
            signal: AbortSignal.timeout(opts.wait ? 95_000 : 5_000),
          });
          if (r.ok) { const j: any = await r.json().catch(() => ({})); return { where: 'worker', result: j.result }; }
          console.error(JSON.stringify({ level: 'warn', where: 'jobs', job: name, status: r.status }));
        } catch (e) { console.error(JSON.stringify({ level: 'warn', where: 'jobs', job: name, error: String((e as Error)?.message || e) })); }
      }
      // No worker to be had: here, then. Waited for when asked; otherwise it runs on while the request is answered.
      if (opts.wait) return { where: 'here', result: await local(name, params) };
      local(name, params).catch((e) => console.error(JSON.stringify({ level: 'error', where: 'job here', job: name, error: String((e as Error)?.message || e) })));
      return { where: 'here' };
    },
  };
}

// The local runner the API uses when there's no worker: the job by name, with the API's own connections
export function localRunner(ctx: JobCtx, jobs: { name: string; run: (ctx: JobCtx, params: any) => Promise<unknown> }[]): RunLocal {
  return async (name, params) => {
    const job = jobs.find((j) => j.name === name);
    if (!job) throw new Error('No job called ' + name);
    return job.run(ctx, params);
  };
}
