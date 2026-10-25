// Add To My Shelf From CSV, the slow part: after bgc.start_csv matched what it could (POST /vault/shelf-csv answers
// right away), each title it couldn't match is looked up on BGG (most-rated exact match, the right year when given),
// every matched game gets its details and box art, and bgc.csv_add puts them on the shelf, base games first. Progress
// and anything not found show on /shelf.
import type { Thing } from '../bgg.js';
import type { Job, JobCtx } from './types.js';

export type ShelfCsvParams = { email: string; start: { ids: number[]; search: { title: string; year: number | null }[]; alreadyHad: number } };

const step = (ctx: JobCtx, email: string, patch: object) => ctx.db.one('SELECT bgc.set_import($1, $2::jsonb)', [email, JSON.stringify(patch)]);

export const shelfCsv: Job<ShelfCsvParams> = {
  name: 'shelfCsv',
  concurrent: true,
  async run(ctx, { email, start }) {
    const { db, bgg } = ctx;
    if (!email || !start) throw new Error('shelfCsv needs { email, start }');
    try {
      const search = start.search || [];
      await step(ctx, email, { step: search.length ? 'Looking up ' + search.length + ' games on BGG' : 'Getting game details and box art' });
      const chosen: { title: string; id: number | null }[] = [];
      for (const s of search) {
        const t = await bgg.findByTitle(s.title, { year: s.year || null, want: 'boardgame' }).catch(() => null);
        chosen.push({ title: s.title, id: t ? t.id : null });
      }
      await step(ctx, email, { step: 'Getting game details and box art' });
      const ids = [...new Set([...(start.ids || []).map(Number), ...chosen.filter((c) => c.id).map((c) => c.id as number)])];
      const things: Thing[] = [];
      for (let i = 0; i < ids.length; i += 20) for (const t of await bgg.things(ids.slice(i, i + 20))) things.push(await bgg.withCover(t));
      const notFound = chosen.filter((c) => !c.id).map((c) => c.title);
      const r = await db.one('SELECT bgc.csv_add($1, $2::jsonb, $3::jsonb, $4::int)', [email, JSON.stringify(things), JSON.stringify(notFound), start.alreadyHad || 0]);
      return { email, lookedUp: search.length, found: things.length, notFound: notFound.length, status: r };
    } catch (e) {
      await step(ctx, email, { state: 'error', message: 'The import didn’t finish: ' + String((e as Error)?.message || e).slice(0, 200) }).catch(() => null);
      throw e;
    }
  },
};
