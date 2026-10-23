// Ask Nathan. Ported from the n8n Ask workflow (n8n/gen.js section 18).
//   POST /vault/ask          the whole answer at once: the same JSON as n8n's /webhook/vault/ask
//   POST /vault/ask/stream   the same answer as Server-Sent Events while he works:
//     stage   { stage: 'reading' | 'looking' | 'writing' }
//     partial { summary, highlights } or { pick, alternative }, the words so far (only games on the shortlist)
//     done    the finished answer, exactly as /vault/ask sends it
//     error   { status, message }
//   Closing the connection (Stop) stops him; nothing is saved for a stopped answer.
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import { ApiError, parse } from '../errors.js';
import { askNathan, respondBody, type NathanDeps } from '../nathan/ask.js';

// The shape only; Nathan's own first step checks the details (length, photo type, ids) with n8n's exact messages
const AskBody = z.object({
  question: z.string().max(5_000).optional(),
  image: z.string().max(3_500_000).nullable().optional(),
  playerIds: z.array(z.string().max(40)).max(50).optional(),
  previous: z.record(z.string(), z.unknown()).nullable().optional(),
  mentioned: z.array(z.string().max(40)).max(200).optional(),
  recent: z.array(z.string().max(40)).max(100).optional(),
  chatKey: z.string().max(80).optional(),
  noMemory: z.boolean().optional(),
  shelf: z.string().max(40).optional(),
}).passthrough();

export function askRoutes(deps: NathanDeps | null) {
  const ready = () => { if (!deps) throw new ApiError(503, 'Nathan isn’t set up on this server yet'); return deps; };
  const body = async (c: any) => {
    const b = parse(AskBody, await c.req.json().catch(() => null), 'That question didn’t come through. Try again.');
    delete (b as any).test; // test runs come only from inside the server (tools/askAs.ts), never over the web
    delete (b as any).testMemory;
    return b;
  };

  return new Hono<AuthEnv>()
    .post('/ask', async (c) => {
      const r = await askNathan(ready(), c.get('auth'), await body(c));
      void r.after();
      return c.json(respondBody(r.answer, r.chatKey));
    })
    .post('/ask/stream', async (c) => {
      const d = ready();
      const b = await body(c);
      const auth = c.get('auth');
      const stop = new AbortController();
      return streamSSE(c, async (sse) => {
        sse.onAbort(() => stop.abort());
        let last = '', lastAt = 0;
        try {
          const r = await askNathan(d, auth, b, {
            signal: stop.signal,
            stage: (stage) => void sse.writeSSE({ event: 'stage', data: JSON.stringify({ stage }) }),
            partial: (p) => {
              const s = JSON.stringify(p);
              if (!p || s === last || Date.now() - lastAt < 60) return;
              last = s; lastAt = Date.now();
              void sse.writeSSE({ event: 'partial', data: s });
            },
          });
          await sse.writeSSE({ event: 'done', data: JSON.stringify(respondBody(r.answer, r.chatKey)) });
          void r.after();
        } catch (e) {
          if (stop.signal.aborted) return;
          const err = e instanceof ApiError ? e : new ApiError(500, 'Something went wrong on our side. Try again in a minute.');
          if (!(e instanceof ApiError)) console.error(JSON.stringify({ level: 'error', where: 'ask stream', error: String((e as Error)?.stack || e) }));
          await sse.writeSSE({ event: 'error', data: JSON.stringify({ status: err.status, message: err.message }) });
        }
      });
    });
}
