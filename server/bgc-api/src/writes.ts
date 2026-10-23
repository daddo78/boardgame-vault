// Checking a change's input as n8n does: the workflow's own Validate node (validate.gen.ts) runs on the same body and
// sign-in, so both accept and reject the same things. A rejection is { ok: false, status, message }, passed on as is.
import type { Context } from 'hono';
import type { AuthEnv } from './auth.js';
import { fromDb } from './errors.js';
import { VALIDATE } from './validate.gen.js';

export async function validated(workflow: keyof typeof VALIDATE, c: Context<AuthEnv>): Promise<Record<string, any>> {
  const body = await c.req.json().catch(() => null);
  const json = { body: body && typeof body === 'object' && !Array.isArray(body) ? body : {}, _auth: c.get('auth') };
  const [out] = VALIDATE[workflow]({ first: () => ({ json }) });
  return fromDb(out?.json ?? null);
}
