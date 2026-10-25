// Health Check (daily 9:00): emails Dan if the nightly database backup hasn't succeeded in 26 hours, or no play has come
// in for 3 days (the nightly BGG syncs fail quietly when BGG changes something).
import type { Job } from './types.js';

export type HealthStatus = { last_ok: string | Date | null; last_error: string | null; last_fail: string | Date | null; newest_play: string | Date | null };

// The problems worth an email, from the status row (none means all is well)
export function healthProblems(s: HealthStatus, now = Date.now()): string[] {
  const problems: string[] = [];
  const lastOk = s.last_ok ? new Date(s.last_ok) : null;
  if (!lastOk || now - lastOk.getTime() > 26 * 3600 * 1000) {
    problems.push('The nightly database backup has not succeeded since ' + (lastOk ? lastOk.toISOString() : 'it was set up') + '.'
      + (s.last_error ? '\nLast error: ' + String(s.last_error).slice(-400) : '')
      + '\nBackups go to the private GitHub repo daddo78/bgc-backups from the bgc-backup container on the Hostinger server.');
  }
  // Plays arrive nightly from BGG (syncPlays, memberPlaysNightly); a quiet sync looks the same as a quiet week, except it never ends
  const newest = s.newest_play ? new Date(s.newest_play) : null;
  if (!newest || now - newest.getTime() > 3 * 86400 * 1000) {
    problems.push('No new plays have come in since ' + (newest ? newest.toISOString().slice(0, 10) : 'ever') + '. Check the nightly BGG syncs (jobs syncPlays and memberPlaysNightly: Admin → Dashboard, or the job_runs table).');
  }
  return problems;
}

export const healthCheck: Job<{}> = {
  name: 'healthCheck',
  schedule: { at: '09:00' },
  async run({ db, mail, config }) {
    const s = await db.row<HealthStatus>('SELECT (SELECT max(at) FROM backup_runs WHERE ok) AS last_ok, (SELECT message FROM backup_runs WHERE NOT ok ORDER BY at DESC LIMIT 1) AS last_error, ' +
      '(SELECT max(at) FROM backup_runs WHERE NOT ok) AS last_fail, (SELECT max(played_on) FROM plays) AS newest_play', []);
    const problems = healthProblems(s || { last_ok: null, last_error: null, last_fail: null, newest_play: null });
    if (!problems.length) return { problems: 0 };
    const sent = await mail({ to: config.ownerEmails[0], subject: 'Board Game Curator: ' + problems.length + ' thing' + (problems.length === 1 ? '' : 's') + ' to look at', text: problems.join('\n\n') });
    return { problems: problems.length, emailed: sent, text: problems };
  },
};
