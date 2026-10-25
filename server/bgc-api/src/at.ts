// The Airtable-compatible adapter (at.request in server/bgc-db/schema/002): Dan's games, people and ratings still live
// behind it in Airtable's record shape, because that is what the page reads. One call shape for every table.
import type { Db } from './db.js';
import type { AtRecord } from './fields.js';

export const atRequest = (db: Db, table: string, method: string, path: string, body: unknown, formula = '') =>
  db.one<any>('SELECT at.request($1, $2, $3, $4::jsonb, $5)', [table, method, path, body == null ? 'null' : JSON.stringify(body), formula]);

export async function atList(db: Db, table: string): Promise<AtRecord[]> {
  const r = await atRequest(db, table, 'GET', '', null);
  return Array.isArray(r?.records) ? r.records : [];
}
// New records, ten at a time (the Airtable API's batch size, which the adapter kept)
export async function atCreate(db: Db, table: string, fields: Record<string, unknown>[]): Promise<AtRecord[]> {
  const out: AtRecord[] = [];
  for (let i = 0; i < fields.length; i += 10) {
    const r = await atRequest(db, table, 'POST', '', { records: fields.slice(i, i + 10).map((f) => ({ fields: f })), typecast: true, returnFieldsByFieldId: true });
    out.push(...(Array.isArray(r?.records) ? r.records : []));
  }
  return out;
}
// Changes to existing records, ten at a time; upsertOn: a field whose value finds the record to update (or makes a new one)
export async function atPatch(db: Db, table: string, records: { id?: string; fields: Record<string, unknown> }[], upsertOn?: string): Promise<void> {
  for (let i = 0; i < records.length; i += 10) {
    await atRequest(db, table, 'PATCH', '', { ...(upsertOn ? { performUpsert: { fieldsToMergeOn: [upsertOn] } } : {}), records: records.slice(i, i + 10), typecast: true });
  }
}
