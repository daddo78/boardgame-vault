// Every error leaves as { ok: false, message } with a plain message, the same shape the n8n webhooks send.
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) { super(message); }
}

// The bgc.* functions answer { ok: false, status, message } when a rule says no; pass that on unchanged
export function fromDb<T extends { ok?: boolean; status?: number; message?: string }>(r: T | null): T {
  if (!r) throw new ApiError(500, 'Something went wrong on our side. Try again in a minute.');
  if (r.ok === false) throw new ApiError((r.status || 400) as ContentfulStatusCode, r.message || 'That didn’t work');
  return r;
}

export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ ok: false, message: err.message }, err.status);
  console.error(JSON.stringify({ level: 'error', path: c.req.path, error: String(err?.stack || err) }));
  return c.json({ ok: false, message: 'Something went wrong on our side. Try again in a minute.' }, 500);
}
