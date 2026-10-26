// BGG ratings (daily 4:50, after the play syncs): for everyone with a BGG username, on a player card or their own
// account, their ratings from BGG (out of 10). For a member who linked BGG (bggAccount.ts) those are their stars too
// (BGG's 8 is 4 stars); everyone else's stay apart, shown as BGG's. What was left of the old Sync People workflow
// once bgc.refresh_member took over making player cards from plays (during each member's play sync) and
// at.player_history started deriving histories from the plays table (schema/038).
import type { Job } from './types.js';

export const syncPeople: Job<{}> = {
  name: 'syncPeople',
  schedule: { at: '04:50' },
  async run({ db, bgg }) {
    const names = (await db.one<string[]>('SELECT bgc.bgg_usernames()', [])) || [];
    let fetched = 0, ratings = 0, stars = 0;
    const missed: string[] = [];
    for (const u of names) {
      const r = await bgg.collectionRatings(u);
      if (!r.ok) { missed.push(u); continue; }
      fetched++;
      ratings += Number(await db.one<number>('SELECT bgc.bgg_ratings_save($1, $2::jsonb)', [u, JSON.stringify(r.ratings)])) || 0;
      stars += Number(await db.one<number>('SELECT bgc.stars_from_bgg($1)', [u])) || 0; // a member who linked BGG: BGG's rating is their stars
    }
    return { usernames: names.length, fetched, ratings, stars, missed };
  },
};
