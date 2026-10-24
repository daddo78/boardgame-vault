// Start the API. On SIGTERM (a deploy handing over to the new container) it stops taking new requests,
// finishes the ones in flight, then closes the database pool.
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { googleVerifier } from './auth.js';
import { loadConfig } from './config.js';
import { pgDb } from './db.js';

const config = loadConfig();
const db = pgDb(config.databaseUrl);
const app = createApp({ db, verify: googleVerifier(config.googleClientId), config });

const server = serve({ fetch: app.fetch, port: config.port }, (info) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'bgc-api listening', port: info.port, version: config.version })));

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ at: new Date().toISOString(), msg: 'stopping', signal }));
  setTimeout(() => process.exit(0), 10_000).unref(); // never hang a deploy
  server.close(() => db.close().finally(() => process.exit(0)));
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
// A promise nobody awaited that failed (a stray background save): one line and on we go. Node would otherwise exit,
// dropping every request in flight; whatever request it came from has its own error handling.
process.on('unhandledRejection', (e) => console.error(JSON.stringify({ level: 'error', where: 'unhandled', error: String((e as Error)?.stack || e) })));
