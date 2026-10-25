// A background job: a name, when it runs on its own (if it does), and what it does. The worker (jobs/server.ts) runs
// them on their schedules and on request; the API runs the same functions itself when there's no worker.
import type { Bgg } from '../bgg.js';
import type { Config } from '../config.js';
import type { Db } from '../db.js';
import type { Fetch } from '../http.js';
import type { Mail } from '../mail.js';

export type Schedule =
  | { at: string }            // once a day at "HH:MM" on the worker's clock (JOBS_TZ)
  | { hourlyAt: number }      // every hour at this minute
  | { everyMinutes: number }; // every so many minutes, from when the worker started

export type JobCtx = {
  db: Db;
  fetch: Fetch;
  config: Config;
  bgg: Bgg;
  mail: (m: Mail) => Promise<boolean>; // never throws; false when there's no key or Resend said no
};

export type Job<P = any> = {
  name: string;
  schedule?: Schedule;
  // Several of these may run at once (one per member); a job without it is skipped while its last run is still going
  concurrent?: boolean;
  run: (ctx: JobCtx, params: P) => Promise<unknown>;
};
