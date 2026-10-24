// How an answer from Nathan is checked against a question in tests/nathan.json. One copy for both places that score:
// test-nathan.js requires it, and gen.js pastes this file in front of the nightly self-test's Score code node (so no
// require there). Plain functions only, nothing from node.
// Everything an answer says, as one string (summary, picks, highlights, notes, and the "Nathan has it" the cards show)
const textOf = (a) => [a.summary, a.note, a.message, a.error, a.pick && [a.pick.title, a.pick.why, a.pick.tableFeel], a.alternative && [a.alternative.title, a.alternative.why],
  ...(a.highlights || []).map((h) => [h.title, h.why]), a.gap && a.gap.missing,
  ...[a.pick, a.alternative, ...(a.highlights || [])].filter((x) => x && x.off && (x.off.friends || []).length).map((x) => x.off.friends.join(' & ') + ' has it')].flat(3).filter(Boolean).join(' \n ');
// The problems with answer a to test t (none means it passed)
const score = (t, a) => {
  const low = textOf(a).toLowerCase();
  const p = [];
  if (a.error) p.push('error: ' + String(a.error).slice(0, 200));
  if (a.ok === false && a.message) p.push(String(a.message).slice(0, 120));
  for (const s of t.includes || []) if (!low.includes(s.toLowerCase())) p.push('missing "' + s + '"');
  if (t.includesAny && !t.includesAny.some((s) => low.includes(s.toLowerCase()))) p.push('none of ' + t.includesAny.join(' / '));
  for (const s of t.excludes || []) if (low.includes(s.toLowerCase())) p.push('should not say "' + s + '"');
  const n = (a.matchIds || []).length;
  if (t.matchMin != null && n < t.matchMin) p.push(n + ' games, expected at least ' + t.matchMin);
  if (t.matchMax != null && n > t.matchMax) p.push(n + ' games, expected at most ' + t.matchMax);
  if (t.intent && a.intent !== t.intent) p.push('answered as ' + a.intent + ', expected ' + t.intent);
  if (t.mode && a.mode !== t.mode) p.push('answered as ' + a.mode + ', expected ' + t.mode);
  if (t.offTopic && !a.offTopic) p.push('expected an off-topic redirect');
  if (t.playerCount !== undefined && ((a.understood || {}).playerCount ?? null) !== t.playerCount) p.push('understood ' + ((a.understood || {}).playerCount ?? 'no') + ' players, expected ' + t.playerCount);
  if (t.remembers && !(a.remembered || []).length) p.push('expected Nathan to remember something');
  if (t.remembers === false && (a.remembered || []).length) p.push('should not remember: ' + a.remembered.join('; ').slice(0, 120));
  if (t.asks !== undefined && !!a.ask !== t.asks) p.push(t.asks ? 'expected a question back' : 'should not ask: ' + String(a.ask).slice(0, 120));
  if (t.cites && !(a.sources || []).some((x) => !t.cites.page || x.page === t.cites.page)) p.push('expected a page from the rulebook' + (t.cites.page ? ' (p. ' + t.cites.page + ')' : '') + ', got ' + JSON.stringify((a.sources || []).map((x) => x.label + ' p.' + x.page)));
  const words = String(a.summary || '').split(/\s+/).filter(Boolean).length;
  if (t.maxWords && words > t.maxWords) p.push(words + ' words, expected at most ' + t.maxWords);
  return p;
};
if (typeof module !== 'undefined') module.exports = { textOf, score };
