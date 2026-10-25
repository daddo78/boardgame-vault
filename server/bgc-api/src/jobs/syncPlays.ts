// Dan's plays from BGG, now the same way as everyone's (memberPlays: the plays table, then bgc.refresh_member recounts
// his shelf). The nightly run (memberPlaysNightly, 4:30) covers him too; this job is "sync Dan's plays now" on request:
// POST /run/syncPlays on the worker.
import { ownerBggUsername } from '../catalog.js';
import { memberPlays } from './memberPlays.js';
import type { Job } from './types.js';

export const syncPlays: Job<{}> = {
  name: 'syncPlays',
  async run(ctx) {
    const { db, config } = ctx;
    const email = config.ownerEmails[0];
    const username = await ownerBggUsername(db, config);
    if (!username) throw new Error('No BGG username for the owner (set BGG_USERNAME or the admin\'s BGG username)');
    const s = await db.one<{ ok: boolean; message?: string }>('SELECT bgc.start_import($1, $2)', [email, username]);
    if (!s?.ok) throw new Error(s?.message || 'An import is already running');
    return memberPlays.run(ctx, { email, username });
  },
};
