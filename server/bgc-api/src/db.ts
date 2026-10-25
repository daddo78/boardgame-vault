// Postgres, through the same bgc.* functions the n8n workflows call. They hold the rules (membership,
// friends, privacy), so a route here only passes the signed-in email and the checked inputs along.
import pg from 'pg';

export interface Db {
  // One row's first column, e.g. one('SELECT bgc.my_profile($1)', [email])
  one<T>(sql: string, params: unknown[]): Promise<T | null>;
  // The first row, by column name (Nathan's steps read several columns at once, as from n8n's Postgres node)
  row<T = Record<string, any>>(sql: string, params: unknown[]): Promise<T | null>;
  // Every row, by column name (the jobs: each member to sync, recent runs)
  rows<T = Record<string, any>>(sql: string, params: unknown[]): Promise<T[]>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

// url undefined: pg reads PGHOST, PGUSER, PGPASSWORD and PGDATABASE from the environment.
// statementTimeoutMs: the jobs raise it (a BGG import's at.save_plays over a thousand plays takes a while)
export function pgDb(url: string | undefined, opts: { statementTimeoutMs?: number; max?: number } = {}): Db {
  const pool = new pg.Pool({ connectionString: url, max: opts.max ?? 8, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 20_000, application_name: 'bgc-api' });
  pool.on('error', (e) => console.error(JSON.stringify({ level: 'error', where: 'pg pool', error: e.message })));
  return {
    async one<T>(sql: string, params: unknown[]) {
      const r = await pool.query({ text: sql, values: params, rowMode: 'array' });
      return (r.rows[0]?.[0] ?? null) as T | null;
    },
    async row<T>(sql: string, params: unknown[]) {
      const r = await pool.query(sql, params);
      return (r.rows[0] ?? null) as T | null;
    },
    async rows<T>(sql: string, params: unknown[]) {
      const r = await pool.query(sql, params);
      return r.rows as T[];
    },
    async ping() { await pool.query('SELECT 1'); },
    close: () => pool.end(),
  };
}

// What bgc.sign_in answers (schema/017_sign_in_admin.sql)
export type SignIn = { member: false } | { member: true; id: number; name: string; isAdmin: boolean; playerId: string | null; playerName: string | null };

export const signIn = (db: Db, email: string) => db.one<SignIn>('SELECT bgc.sign_in($1)', [email]);
export const myProfile = (db: Db, email: string) => db.one<Record<string, unknown>>('SELECT bgc.my_profile($1)', [email]);
export const profilePage = (db: Db, email: string, friend: number | null) =>
  db.one<{ ok: boolean; status?: number; message?: string }>('SELECT bgc.profile_page($1, $2::bigint)', [email, friend]);
