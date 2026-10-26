// Settings come from the environment (on the server: ~/bgc-db/.env plus docker-compose.yml). Nothing secret has a default.
import { z } from 'zod';

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  // Either a full address, or the standard PGHOST/PGUSER/PGPASSWORD/PGDATABASE (what docker-compose.yml sets)
  DATABASE_URL: z.string().optional(),
  PGHOST: z.string().optional(),
  // The same Google sign-in client and owner as n8n/gen.js
  GOOGLE_CLIENT_ID: z.string().default('91195561493-sbejlc54u0jgr6bid835k9mo8k3j5kqc.apps.googleusercontent.com'),
  OWNER_EMAILS: z.string().default('dandehaan@gmail.com'),
  // The site, plus (only when asked: ALLOW_LOCALHOST=true, which the tests and `npm run dev` set) any localhost port for
  // testing the page on your own computer. Off by default so the server, which never sets it, admits only the site.
  ALLOWED_ORIGINS: z.string().default('https://bg.ondorilabo.com'),
  ALLOW_LOCALHOST: z.enum(['true', 'false']).default('false'),
  // Requests per member per minute (a burst of this many, then refilling over the minute)
  RATE_PER_MINUTE: z.coerce.number().int().positive().default(120),
  VERSION: z.string().default('dev'),
  LOG_REQUESTS: z.enum(['true', 'false']).default('true'),
  // Nathan: without the OpenRouter key his routes say he isn't set up; without the BGG token he can't look up games we don't know
  OPENROUTER_API_KEY: z.string().optional(),
  BGG_TOKEN: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  // Seals members' BGG session tokens (bggAccount.ts): 64 hex characters, in Infisical. Unset: nobody can link BGG.
  BGG_LINK_KEY: z.string().optional(),
  // Whose BGG plays the nightly sync and a new game's play count come from (Dan's); unset: the admin's BGG username in the database
  BGG_USERNAME: z.string().optional(),
  // The jobs worker (bgc-jobs, the same image started with node dist/jobs/server.js): where the API hands background work
  // to. Unset (tests, npm run dev): the API runs that work itself.
  JOBS_URL: z.string().optional(),
  JOBS_PORT: z.coerce.number().int().positive().default(8788),
  JOBS_TZ: z.string().default('America/Detroit'),  // the schedules' clock (4:00 means 4:00 in Michigan)
  JOBS_SCHEDULES: z.enum(['true', 'false']).default('true'),
  // The rulebook page service (bgc-pages): holds a PDF only while Nathan reads it
  PAGES_URL: z.string().default('http://bgc-pages:8000'),
});

export type Config = {
  port: number;
  databaseUrl: string | undefined;
  googleClientId: string;
  ownerEmails: string[];
  allowedOrigins: string[];
  allowLocalhost: boolean;
  ratePerMinute: number;
  version: string;
  logRequests: boolean;
  openrouterKey: string | undefined;
  bggToken: string | undefined;
  resendKey: string | undefined;
  bggLinkKey: string | undefined;
  bggUsername: string | undefined;
  jobsUrl: string | undefined;
  jobsPort: number;
  jobsTz: string;
  jobsSchedules: boolean;
  pagesUrl: string;
};

const list = (s: string) => s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = Env.safeParse(env);
  if (!r.success) throw new Error('Bad settings: ' + r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const e = r.data;
  if (!e.DATABASE_URL && !e.PGHOST) throw new Error('Bad settings: set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE');
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    googleClientId: e.GOOGLE_CLIENT_ID,
    ownerEmails: list(e.OWNER_EMAILS),
    allowedOrigins: list(e.ALLOWED_ORIGINS),
    allowLocalhost: e.ALLOW_LOCALHOST === 'true',
    ratePerMinute: e.RATE_PER_MINUTE,
    version: e.VERSION,
    logRequests: e.LOG_REQUESTS === 'true',
    openrouterKey: e.OPENROUTER_API_KEY || undefined,
    bggToken: e.BGG_TOKEN || undefined,
    resendKey: e.RESEND_API_KEY || undefined,
    bggLinkKey: e.BGG_LINK_KEY || undefined,
    bggUsername: e.BGG_USERNAME || undefined,
    jobsUrl: e.JOBS_URL ? e.JOBS_URL.replace(/\/+$/, '') : undefined,
    jobsPort: e.JOBS_PORT,
    jobsTz: e.JOBS_TZ,
    jobsSchedules: e.JOBS_SCHEDULES === 'true',
    pagesUrl: e.PAGES_URL.replace(/\/+$/, ''),
  };
}
