// A member's plays from BGG (Connect BGG Plays, and the nightly Sync Member Plays for everyone with a BGG username).
// The shelf is managed here, not on BGG, so this brings in plays only (a member who linked BGG gets the shelf sent there,
// bggOutbox.ts): every play from their account -> their player list;
// a game's plays count as soon as the game is on their shelf. Progress shows on /shelf (members.import_status).
import { parsePlays } from '../bgg.js';
import type { Job, JobCtx } from './types.js';

export type MemberPlaysParams = { email: string; username: string };

const setImport = (ctx: JobCtx, email: string, patch: object) => ctx.db.one('SELECT bgc.set_import($1, $2::jsonb)', [email, JSON.stringify(patch)]);

export const memberPlays: Job<MemberPlaysParams> = {
  name: 'memberPlays',
  concurrent: true, // one per member; bgc.start_import keeps two for the same member apart
  async run(ctx, { email, username }) {
    const { db, bgg } = ctx;
    if (!email || !username) throw new Error('memberPlays needs { email, username }');
    try {
      const parsed = parsePlays(await bgg.plays(username));
      if (!parsed.ok) {
        await setImport(ctx, email, { state: 'error', message: parsed.message || 'BGG didn’t answer' });
        return { email, ok: false, message: parsed.message };
      }
      const saved = await db.one<{ plays: number; newPlays: number }>('SELECT at.save_plays($1, $2::jsonb)', [email, JSON.stringify(parsed.plays)]);
      await db.one('SELECT bgc.merge_site_plays($1)', [email]); // a play logged here that BGG now has too is the same play
      await db.one('SELECT bgc.apply_place_aliases($1)', [email]); // plays at a place's old (merged) name say its name
      const r = await db.one<{ players: number }>('SELECT bgc.refresh_member($1)', [email]);
      await setImport(ctx, email, { state: 'done', step: 'Done', plays: saved?.plays ?? 0, players: r?.players ?? 0, finished: new Date().toISOString() });
      return { email, ok: true, plays: saved?.plays ?? 0, newPlays: saved?.newPlays ?? 0, players: r?.players ?? 0 };
    } catch (e) {
      await setImport(ctx, email, { state: 'error', message: 'The import didn’t finish: ' + String((e as Error)?.message || e).slice(0, 200) }).catch(() => null);
      throw e;
    }
  },
};

// Nightly 4:30: every member with a BGG username, Dan included (since 2026-10-25), one after another
export const memberPlaysNightly: Job<{}> = {
  name: 'memberPlaysNightly',
  schedule: { at: '04:30' },
  async run(ctx) {
    const members = await ctx.db.rows<{ ok: string; email: string; username: string }>(
      "SELECT bgc.start_import(m.google_email, m.bgg_username) ->> 'ok' AS ok, m.google_email AS email, m.bgg_username AS username " +
      "FROM members m WHERE nullif(btrim(m.bgg_username), '') IS NOT NULL ORDER BY m.id", []);
    const results: unknown[] = [];
    for (const m of members.filter((x) => String(x.ok) === 'true' && x.email)) {
      try { results.push(await memberPlays.run(ctx, { email: m.email, username: m.username })); }
      catch (e) { results.push({ email: m.email, ok: false, error: String((e as Error)?.message || e) }); }
    }
    return { members: members.length, synced: results.filter((r: any) => r.ok).length, results };
  },
};
