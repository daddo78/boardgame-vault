// Feedback. Ported from the n8n workflow Feedback (n8n/gen.js section 43): bgc.feedback saves it, and Dan gets an
// email he can reply to, written by n8n's own Compose node (nodes.gen.ts). Admins mark one seen or done the same way.
import { Hono } from 'hono';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { fromDb } from '../errors.js';
import type { Fetch } from '../http.js';
import { sendMail } from '../mail.js';
import { runNode } from '../nodes.js';
import { body } from '../request.js';

export type MailDeps = { resendKey?: string; fetch?: Fetch; ownerEmail: string };

export function feedbackRoutes(db: Db, { resendKey, fetch: f = fetch, ownerEmail }: MailDeps) {
  return new Hono<AuthEnv>()
    // POST /vault/feedback { kind, mood, message, page, device } | { action: 'status', id, status } (admins)
    .post('/feedback', async (c) => {
      const b = await body(c);
      const r = fromDb(await db.one<Record<string, any>>('SELECT bgc.feedback($1, $2::jsonb)', [c.get('auth').email, JSON.stringify(b)]));
      if (!r.id) return c.json(r); // a status change: nothing to email
      const m = runNode('feedbackSend', 'Compose', r, { Webhook: { body: b } });
      await sendMail(f, resendKey, { to: ownerEmail, subject: m.subject, text: m.text, replyTo: m.replyTo });
      return c.json({ ok: true, message: 'Thanks! Dan reads every one.' });
    });
}
