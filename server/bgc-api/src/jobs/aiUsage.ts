// AI Spending (every hour at :07): what this site's OpenRouter key has spent in total, and the account's balance, for
// Admin → Costs (bgc.costs_page reads the snapshots).
import type { Job, JobCtx } from './types.js';

async function openrouter({ fetch: f, config }: JobCtx, path: string): Promise<any> {
  try {
    const r = await f('https://openrouter.ai/api/v1/' + path, { headers: { Authorization: 'Bearer ' + config.openrouterKey }, signal: AbortSignal.timeout(20_000) });
    return r.ok ? ((await r.json()) as any).data || {} : {};
  } catch { return {}; }
}
const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));

export const aiUsage: Job<{}> = {
  name: 'aiUsage',
  schedule: { hourlyAt: 7 },
  async run(ctx) {
    if (!ctx.config.openrouterKey) throw new Error('OPENROUTER_API_KEY is not set');
    const key = await openrouter(ctx, 'key');
    const credits = await openrouter(ctx, 'credits');
    const row = { keyUsage: num(key.usage), keyLimit: num(key.limit), creditsTotal: num(credits.total_credits), creditsUsed: num(credits.total_usage) };
    if (row.keyUsage === null && row.creditsTotal === null) throw new Error('OpenRouter didn’t answer');
    await ctx.db.one('SELECT bgc.log_usage($1::numeric, $2::numeric, $3::numeric, $4::numeric)', [row.keyUsage, row.keyLimit, row.creditsTotal, row.creditsUsed]);
    return row;
  },
};
