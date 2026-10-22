// Every error leaves as { ok: false, message } with a plain message, the same shape the n8n webhooks send.
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(public status: ContentfulStatusCode, message: string) { super(message); }
}

// The bgc.* functions answer { ok: false, status, message } when a rule says no; pass that on unchanged
export function fromDb<T extends { ok?: boolean; status?: number; message?: string }>(r: T | null): T {
  if (!r) throw new ApiError(500, 'Something went wrong on our side. Try again in a minute.');
  if (r.ok === false) throw new ApiError((r.status || 400) as ContentfulStatusCode, r.message || 'That didn’t work');
  return r;
}

// Check an input against its schema; a bad one is a 400 with the route's plain message (zod's own wording is for developers)
export function parse<S extends z.ZodType>(schema: S, value: unknown, message = 'That request doesn’t look right'): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new ApiError(400, message);
}

export function onError(err: Error, c: Context) {
  if (err instanceof ApiError) return c.json({ ok: false, message: err.message }, err.status);
  console.error(JSON.stringify({ level: 'error', path: c.req.path, error: String(err?.stack || err) }));
  return c.json({ ok: false, message: 'Something went wrong on our side. Try again in a minute.' }, 500);
}
