// Rebuild schema/021 after editing checks.sql:  node server/bgc-db/tests/make-self-check.js server/bgc-db/tests/checks.sql server/bgc-db/schema/021_self_check.sql
// Builds schema/021_self_check.sql from tests/checks.sql: the same checks as one function that undoes its own changes
const fs = require('fs');
const [src, out] = process.argv.slice(2);
const text = fs.readFileSync(src, 'utf8');
// Each check line: SELECT pg_temp.check(<condition>, '<what>');  (may span lines)
const body = text.slice(text.indexOf('-- Test people'), text.lastIndexOf('ROLLBACK;'));
const stmts = body.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^--/.test(s.replace(/^(--[^\n]*\n)+/, '').trim()) || /^(--[^\n]*\n)*\s*(SELECT|INSERT|UPDATE)/.test(s));
const lines = [];
for (let st of stmts) {
  st = st.replace(/^(--[^\n]*\n\s*)+/, '').trim();
  if (!st) continue;
  if (/^(INSERT|UPDATE)/.test(st)) { lines.push('    ' + st + ';'); continue; }
  const m = st.match(/^SELECT pg_temp\.check\(([\s\S]*),\s*('(?:[^']|'')*')\s*\)$/);
  if (!m) throw new Error('cannot read: ' + st.slice(0, 80));
  lines.push(`    res := res || jsonb_build_object('what', ${m[2]}, 'ok', coalesce((${m[1].trim()}), false));`);
}
const sql = `-- The site's rules as one self-check: bgc.self_check() runs every check, undoes all its changes, and returns the results.
-- Used after every deploy and by the nightly self-test. Generated from server/bgc-db/tests/checks.sql by make-021.
-- Apply: docker exec -i bgc-postgres psql -U bgc -d bgc -v ON_ERROR_STOP=1 < 021_self_check.sql  (safe to re-run)
BEGIN;

CREATE OR REPLACE FUNCTION bgc.self_check() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE res jsonb := '[]';
BEGIN
  BEGIN
${lines.join('\n')}
    RAISE EXCEPTION 'self-check done' USING ERRCODE = 'P0001'; -- undo everything the checks did
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'self-check done' THEN res := res || jsonb_build_object('what', 'the checks crashed: ' || SQLERRM, 'ok', false); END IF;
  END;
  RETURN res;
END $$;

COMMIT;
`;
fs.writeFileSync(out, sql);
console.log(lines.filter((l) => l.includes("'what'")).length + ' checks');
