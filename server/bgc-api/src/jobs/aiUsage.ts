// AI Spending (every hour at :07): what this site's OpenRouter key has spent in total, and the account's balance, for
// Admin → Costs (bgc.costs_page reads the snapshots). When the balance runs low it emails Dan: once when it drops under
// the threshold (settings key ai_balance_alert, in dollars; $10 unless set), again each week while it stays low, and
// afresh after a top-up. What was last sent is kept in settings (key ai_balance_alerted) so a restart doesn't resend.
import type { Job, JobCtx } from './types.js';

async function openrouter({ fetch: f, config }: JobCtx, path: string): Promise<any> {
  try {
    const r = await f('https://openrouter.ai/api/v1/' + path, { headers: { Authorization: 'Bearer ' + config.openrouterKey }, signal: AbortSignal.timeout(20_000) });
    return r.ok ? ((await r.json()) as any).data || {} : {};
  } catch { return {}; }
}
const num = (v: unknown) => (v === undefined || v === null || v === '' ? null : Number(v));

export const DEFAULT_THRESHOLD = 10;
export const REMIND_AFTER_MS = 7 * 86400 * 1000;

export type Alerted = { at: string; remaining: number } | null;
export type BalanceDecision = { send: boolean; remaining: number | null; alerted: Alerted };

// Whether this reading deserves an email, and what to remember afterwards. `last` is what was sent before (null when
// nothing was, or the balance has been fine since). A reading without a balance decides nothing and changes nothing.
export function balanceAlert(creditsTotal: number | null, creditsUsed: number | null, threshold: number, last: Alerted, now = Date.now()): BalanceDecision {
  if (creditsTotal === null || creditsUsed === null) return { send: false, remaining: null, alerted: last };
  const remaining = Math.round((creditsTotal - creditsUsed) * 100) / 100;
  if (remaining >= threshold) return { send: false, remaining, alerted: null }; // fine (or topped up): the next drop under is news again
  if (last && now - Date.parse(last.at) < REMIND_AFTER_MS) return { send: false, remaining, alerted: last };
  return { send: true, remaining, alerted: { at: new Date(now).toISOString(), remaining } };
}

export function balanceMail(remaining: number, threshold: number, creditsTotal: number, last: Alerted) {
  const first = !last;
  return {
    subject: `Board Game Curator: OpenRouter balance is $${remaining.toFixed(2)}`,
    text: [
      (first ? 'The OpenRouter balance has dropped under $' + threshold + '.' : 'The OpenRouter balance is still under $' + threshold + ' (a weekly reminder).'),
      '',
      'Remaining: $' + remaining.toFixed(2) + ' of $' + creditsTotal.toFixed(2) + ' bought in all.',
      'Nathan, photo adds and the rulebook reader stop answering when it reaches $0.',
      '',
      'Top up at https://openrouter.ai/settings/credits. Admin → Costs shows the spend per day; the threshold is the',
      'settings key ai_balance_alert on the server (a number of dollars).',
    ].join('\n'),
  };
}

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

    // The low-balance email
    const saved = await ctx.db.row<{ threshold: unknown; alerted: unknown }>(
      "SELECT (SELECT value FROM settings WHERE key = 'ai_balance_alert') AS threshold, (SELECT value FROM settings WHERE key = 'ai_balance_alerted') AS alerted", []).catch(() => null);
    const threshold = Number(saved?.threshold);
    const t = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
    const last = (saved?.alerted && typeof saved.alerted === 'object' && 'at' in (saved.alerted as object)) ? (saved.alerted as Alerted) : null;
    const d = balanceAlert(row.creditsTotal, row.creditsUsed, t, last);
    let emailed: boolean | undefined;
    if (d.send) {
      const m = balanceMail(d.remaining!, t, row.creditsTotal!, last);
      emailed = await ctx.mail({ to: ctx.config.ownerEmails[0], ...m });
      if (!emailed) d.alerted = last; // Resend said no: try again next hour
    }
    if (d.alerted !== last) {
      await ctx.db.one("INSERT INTO settings (key, value, updated_at) VALUES ('ai_balance_alerted', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [JSON.stringify(d.alerted)]).catch(() => null);
    }
    return { ...row, remaining: d.remaining, ...(emailed === undefined ? {} : { emailed }) };
  },
};
