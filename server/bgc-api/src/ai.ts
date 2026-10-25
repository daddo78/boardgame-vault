// The models the catalog work uses (as n8n/gen.js: VISION_MODEL, ICON_MODEL), one call shape, and the cost line
// bgc.log_ai takes for each call. Nathan has his own request builders in nathan/.
import type { Db } from './db.js';
import type { Fetch } from './http.js';
import { complete, type Completion } from './nathan/openrouter.js';

export const VISION_MODEL = 'google/gemini-2.5-flash-lite';
export const ICON_MODEL = 'anthropic/claude-haiku-5.5';
export const READ_MODEL = 'google/gemini-2.5-flash';

export type AiCost = { feature: string; model: string | null; cost: unknown; in: unknown; out: unknown };
export type AiAnswer = { text: string; model: string | null; cost: AiCost };

// One chat completion; the answer's text, and what it cost (for bgc.log_ai). Only providers that don't store or train
// on the request, and the cost comes back with the usage.
export async function ask(key: string, f: Fetch, feature: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<AiAnswer> {
  const r: Completion = await complete(key, { provider: { data_collection: 'deny' }, usage: { include: true }, ...body }, f, signal);
  const u: any = r.usage || {};
  return { text: r.choices?.[0]?.message?.content || '', model: r.model, cost: { feature, model: r.model, cost: u.cost, in: u.prompt_tokens, out: u.completion_tokens } };
}

// The first {...} in a model's reply, as an object; {} when there isn't one that parses
export function jsonIn(text: string): any {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return {};
  try { return JSON.parse(text.slice(s, e + 1)) || {}; } catch { return {}; }
}

// Record what AI calls cost (never fails the caller)
export async function logAi(db: Db, email: string | null, costs: AiCost[]): Promise<void> {
  if (!costs.length) return;
  await db.one('SELECT bgc.log_ai($1, $2::jsonb)', [email, JSON.stringify(costs)]).catch((e) => console.error(JSON.stringify({ level: 'error', where: 'log_ai', error: String(e?.message || e) })));
}
