// OpenRouter, the same request bodies the n8n workflow sends. Answers come back in the shape n8n's HTTP node gives
// the next step ({ choices: [{ message: { content } }], model, usage }), streamed or not.
import type { Fetch } from '../http.js';

export type Completion = { choices: { message: { content: string } }[]; model: string | null; usage: Record<string, unknown> | null; error?: string };

const URL_ = 'https://openrouter.ai/api/v1/chat/completions';
const TRIES = 3, TIMEOUT_MS = 90_000; // as n8n: 3 tries, 5 s apart, 90 s each
export const timing = { waitMs: 5_000 };

function headers(key: string) {
  return { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://api.ondorilabo.com/vault', 'X-Title': 'Board Game Curator' };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A 4xx other than 429 says our request is wrong (an unknown model, a photo too big, no credit): asking again, three
// times, 5 s apart, would only get the same answer 10 s later. 5xx and 429 are theirs and pass.
const wontChange = (status: number) => status < 500 && status !== 429;

export async function complete(key: string, body: object, f: Fetch = fetch, signal?: AbortSignal): Promise<Completion> {
  let last: unknown;
  for (let i = 0; i < TRIES; i++) {
    if (i) await sleep(timing.waitMs);
    try {
      const r = await f(URL_, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
      const j: any = await r.json();
      if (r.ok && !j.error) return { choices: j.choices, model: j.model ?? null, usage: j.usage ?? null };
      // An error in a 200's body (the provider failed after OpenRouter accepted) carries its own code; without one it's theirs
      const status = r.ok ? Number(j.error?.code) || 500 : r.status;
      last = new Error('OpenRouter ' + status + ': ' + (j.error?.message || 'error'));
      if (wontChange(status)) break;
    } catch (e) { last = e; if (signal?.aborted) break; }
  }
  throw last;
}

// Streamed: onText gets the whole answer so far after each piece. Retries only if nothing has arrived yet (and, as
// above, not for a 4xx that won't change).
export async function stream(key: string, body: object, onText: (soFar: string) => void, f: Fetch = fetch, signal?: AbortSignal): Promise<Completion> {
  let last: unknown;
  for (let i = 0; i < TRIES; i++) {
    if (i) await sleep(timing.waitMs);
    let text = '', model: string | null = null, usage: Record<string, unknown> | null = null;
    try {
      const r = await f(URL_, { method: 'POST', headers: headers(key), body: JSON.stringify({ ...body, stream: true }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) { last = new Error('OpenRouter ' + r.status); if (wontChange(r.status)) break; continue; }
      if (!r.body) throw new Error('OpenRouter: no answer body');
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue; // ": OPENROUTER PROCESSING" keep-alives
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let j: any;
          try { j = JSON.parse(data); } catch { continue; }
          if (j.error) throw new Error('OpenRouter: ' + (j.error.message || 'error'));
          model = j.model ?? model;
          if (j.usage) usage = j.usage;
          const piece = j.choices?.[0]?.delta?.content;
          if (piece) { text += piece; onText(text); }
        }
      }
      return { choices: [{ message: { content: text } }], model, usage };
    } catch (e) {
      last = e;
      if (text || signal?.aborted) break; // part of an answer already shown: don't start over
    }
  }
  throw last;
}
