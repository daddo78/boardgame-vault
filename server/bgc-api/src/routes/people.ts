// Your people and your places (schema/050): the people on your shelf (whom you play with, members or not) and the
// places you play, for Log a Play's search and its Where. New with this service: n8n never had them.
//   GET  /vault/people-mine                                      your people, most played first
//   POST /vault/person-save { id?, name, aliases, active, bggUsername, googleEmail? }   add (no id) or change one
//   POST /vault/person-remove { id }                             one with no plays
//   GET  /vault/places                                           saved places and the places in your plays
//   POST /vault/place-save { action: add | remove, name }
//   POST /vault/person-merge { from, into }                      two names for one person: from's plays and names go to into
//   POST /vault/place-merge { from, into }                       two names for one place: plays move, the old name is kept
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth.js';
import type { Db } from '../db.js';
import { fromDb } from '../errors.js';
import { parseBody } from '../request.js';

const Person = z.object({
  id: z.string().max(40).optional(),
  name: z.string().trim().min(1).max(60),
  aliases: z.union([z.array(z.string().max(60)), z.string().max(600).transform((s) => s.split(','))]).optional().default([])
    .transform((a) => a.map((x) => x.trim()).filter(Boolean).slice(0, 20)),
  active: z.boolean().optional().default(true),
  bggUsername: z.string().trim().regex(/^[A-Za-z0-9_ .-]{0,40}$/).optional().default(''),
  googleEmail: z.string().trim().max(200).optional(), // only an admin's own shelf uses it (the database checks)
});
const Id = z.object({ id: z.string().min(1).max(40) });
const Merge = z.object({ from: z.string().trim().min(1).max(100), into: z.string().trim().min(1).max(100) });
const Place = z.object({ action: z.enum(['add', 'remove']), name: z.string().trim().min(1).max(100) });

export function peopleRoutes(db: Db) {
  const call = (sql: string, params: unknown[]) => db.one<Record<string, any>>(sql, params).then(fromDb);
  return new Hono<AuthEnv>()
    .get('/people-mine', async (c) => c.json(await call('SELECT bgc.my_people($1)', [c.get('auth').email])))
    .post('/person-save', async (c) => {
      const { id, ...p } = await parseBody(c, Person, 'Give them a name');
      return c.json(await call('SELECT bgc.person_save($1, $2, $3::jsonb)', [c.get('auth').email, id || null, JSON.stringify(p)]));
    })
    .post('/person-remove', async (c) => {
      const { id } = await parseBody(c, Id, 'Who?');
      return c.json(await call('SELECT bgc.person_remove($1, $2)', [c.get('auth').email, id]));
    })
    .post('/person-merge', async (c) => {
      const m = await parseBody(c, Merge, 'Pick who to merge into whom');
      return c.json(await call('SELECT bgc.person_merge($1, $2, $3)', [c.get('auth').email, m.from, m.into]));
    })
    .post('/place-merge', async (c) => {
      const m = await parseBody(c, Merge, 'Pick which place to merge into which');
      return c.json(await call('SELECT bgc.place_merge($1, $2, $3)', [c.get('auth').email, m.from, m.into]));
    })
    .get('/places', async (c) => c.json(await call('SELECT bgc.my_places($1)', [c.get('auth').email])))
    .post('/place-save', async (c) => {
      const p = await parseBody(c, Place, 'Name the place');
      return c.json(await call('SELECT bgc.place_save($1, $2::jsonb)', [c.get('auth').email, JSON.stringify(p)]));
    });
}
