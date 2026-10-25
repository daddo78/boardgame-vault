// Nightly Self-Test (5:40): the database checks (bgc.self_check), then Nathan's question set (selftest/nathan.json),
// asked as Dan or as Nathan Schmidt without using anyone's allowance (costs are logged as "tests"). The latest result
// shows on Admin → Dashboard (settings key self_test); Dan gets an email only when something fails.
import { signIn } from '../db.js';
import { askNathan, respondBody } from '../nathan/ask.js';
import TESTS from '../selftest/nathan.json' with { type: 'json' };
import { score, type NathanTest } from '../selftest/score.js';
import type { Job, JobCtx } from './types.js';

const WHO = { dan: { email: 'dandehaan@gmail.com', role: 'owner', shelf: 'main' }, nathan: { email: 'nathan.schmidt@curator.invalid', role: 'friend', shelf: 'mine' } } as const;
export const PAUSE_MS = { between: 6000 }; // spaced out for the AI service (tests set 0)

export type Check = { what: string; ok: boolean; problems?: string[] };

// One question to Nathan as a given member, scored. Never throws: a failure is a failed check.
export async function askOne(ctx: JobCtx, t: NathanTest): Promise<Check> {
  const who = WHO[t.as] || WHO.nathan;
  try {
    const email = who.email;
    const m: any = await signIn(ctx.db, email);
    const owner = who.role === 'owner';
    if (!owner && !m?.member) throw new Error(email + ' is not a member');
    const auth = { role: owner ? 'owner' : 'friend', email, memberId: m?.id ?? null, admin: owner || !!m?.isAdmin, playerId: m?.playerId ?? null, playerName: m?.playerName ?? null } as const;
    const r = await askNathan({ db: ctx.db, openrouterKey: ctx.config.openrouterKey!, bggToken: ctx.config.bggToken, fetch: ctx.fetch }, auth,
      { question: t.q, shelf: t.shelf || who.shelf, previous: t.prev ?? null, noMemory: true, test: true, ...(t.memory ? { testMemory: t.memory } : {}) });
    await r.after(false); // what it cost, nothing else saved
    const problems = score(t, respondBody(r.answer, r.chatKey));
    return { what: t.name, ok: !problems.length, problems };
  } catch (e) {
    const problems = score(t, { error: String((e as Error)?.message || e) });
    return { what: t.name, ok: false, problems };
  }
}

export const selfTest: Job<{ only?: string }> = {
  name: 'selfTest',
  schedule: { at: '05:40' },
  async run(ctx, params) {
    const { db, config, mail } = ctx;
    if (!config.openrouterKey) throw new Error('OPENROUTER_API_KEY is not set');
    const dbChecks: Check[] = await db.one<Check[]>('SELECT bgc.self_check()', [])
      .catch((e) => [{ what: 'the database checks didn\'t run: ' + String((e as Error)?.message || e), ok: false }]) || [];
    const tests = (TESTS as NathanTest[]).filter((t) => !params?.only || t.name.toLowerCase().includes(params.only.toLowerCase()));
    const nathan: Check[] = [];
    for (let i = 0; i < tests.length; i++) {
      if (i && PAUSE_MS.between) await new Promise((r) => setTimeout(r, PAUSE_MS.between));
      nathan.push(await askOne(ctx, tests[i]));
    }
    const failed = [...dbChecks.filter((x) => !x.ok), ...nathan.filter((x) => !x.ok)];
    const summary = { at: new Date().toISOString(), dbPassed: dbChecks.filter((x) => x.ok).length, dbTotal: dbChecks.length,
      nathanPassed: nathan.filter((x) => x.ok).length, nathanTotal: nathan.length, failures: failed.map((x) => ({ what: x.what, problems: x.problems || [] })) };
    await db.one("INSERT INTO settings (key, value, updated_at) VALUES ('self_test', $1::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()", [JSON.stringify(summary)]);
    let emailed = false;
    if (failed.length) {
      const lines = failed.map((x) => '• ' + x.what + ((x.problems || []).length ? '\n    ' + x.problems!.join('; ') : ''));
      emailed = await mail({ to: config.ownerEmails[0], subject: 'Board Game Curator nightly check: ' + failed.length + ' problem' + (failed.length === 1 ? '' : 's'),
        text: 'The nightly self-test found ' + failed.length + ' problem' + (failed.length === 1 ? '' : 's') + '.\n\n' +
          'Database checks: ' + summary.dbPassed + ' of ' + summary.dbTotal + ' passed\nNathan questions: ' + summary.nathanPassed + ' of ' + summary.nathanTotal + ' passed\n\n' + lines.join('\n') +
          '\n\nRun it again any time: POST /run/selfTest on the jobs worker, or locally with TARGET=api node n8n/test-nathan.js.' });
    }
    return { ...summary, emailed };
  },
};
