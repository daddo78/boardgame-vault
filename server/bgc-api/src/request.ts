// Reading a request the way n8n's webhooks did, and the small checks every route shares. All typed on the vault's own
// context (signed-in member in c.get('auth')), so a route can't hand them anything else by mistake.
import type { Context } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from './auth.js';
import { ApiError } from './errors.js';

export type Ctx = Context<AuthEnv>;

// Check an input against its schema; a bad one is a 400 with the route's plain message (zod's own wording is for developers)
export function parse<S extends z.ZodType>(schema: S, value: unknown, message = 'That request doesn’t look right'): z.infer<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new ApiError(400, message);
}

// The JSON body, or null when there isn't one that parses
export const jsonBody = (c: Ctx): Promise<unknown> => c.req.json().catch(() => null);

// The body as an object (n8n's webhook hands the workflow {} for anything else)
export async function body(c: Ctx): Promise<Record<string, any>> {
  const b = await jsonBody(c);
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, any>) : {};
}

// The body checked against a schema; none, or a bad one, is the route's 400
export const parseBody = async <S extends z.ZodType>(c: Ctx, schema: S, message?: string): Promise<z.infer<S>> => parse(schema, await jsonBody(c), message);

// Dan's own collection and people: the owner only, with n8n's message
export function ownerOnly(c: Ctx) {
  if (c.get('auth').role !== 'owner') throw new ApiError(401, 'Sign in as the collection owner to make changes');
}

// ?friend=<member id> on a profile or a wishlist: a positive whole number, or nothing ('' counts as nothing)
export const FriendQuery = z.object({
  friend: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()),
});
