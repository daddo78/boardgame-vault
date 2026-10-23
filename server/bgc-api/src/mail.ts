// Email through Resend's API (the same account n8n sends from over SMTP). The key is RESEND_API_KEY in ~/bgc-db/.env.
// Never throws: true when Resend took the message. Like n8n's email steps, a failed email doesn't fail the request.
import type { Fetch } from './nathan/openrouter.js';

export const MAIL_FROM = 'Board Game Curator <alpha@ondorilabo.com>';

export type Mail = { to: string; subject: string; text: string; html?: string; replyTo?: string };

export async function sendMail(f: Fetch, key: string | undefined, m: Mail): Promise<boolean> {
  if (!key) return false;
  try {
    const r = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [m.to], subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), ...(m.replyTo ? { reply_to: m.replyTo } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) console.error(JSON.stringify({ level: 'error', where: 'mail', status: r.status }));
    return r.ok;
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', where: 'mail', error: String((e as Error).message) }));
    return false;
  }
}
