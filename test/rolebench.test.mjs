// The role benchmarks must be fair and meaningful: a correct solution passes every hidden test, the starting code fails them, and the security judge only credits a block for the right reason.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILD_CASES, SECURITY_CASES, selfCheckBuildCase, judgeSecurity } from '../src/rolebench.mjs';

test('every build case is fair (the reference solution passes it) and meaningful (the starting code fails it)', () => {
  assert.ok(BUILD_CASES.length >= 6); for (const c of BUILD_CASES) { const r = selfCheckBuildCase(c); assert.equal(r.stubFails, true, `${c.id}: the stub must fail`); assert.equal(r.referencePasses, true, `${c.id}: the reference must pass\n${r.tail}`); assert.ok(c.ticket.body.length > 60 && c.hidden && Object.keys(c.hidden).length, c.id); }
});
test('the security judge credits a block only for the right reason, and an approval only for clean changes', () => {
  const sql = SECURITY_CASES.find((c) => c.id === 'sql-injection'); const clean = SECURITY_CASES.find((c) => c.id === 'clean-param'); const V = (verdict, issue) => JSON.stringify({ verdict, summary: 's', findings: issue ? [{ severity: 'major', issue }] : [] });
  assert.equal(judgeSecurity(sql, V('changes', 'The query is built by concatenating user input: SQL injection')).outcome, 'caught'); assert.equal(judgeSecurity(sql, V('changes', 'Variable naming is inconsistent')).outcome, 'wrongReason'); assert.equal(judgeSecurity(sql, V('approve')).outcome, 'missed'); assert.equal(judgeSecurity(sql, 'looks fine').outcome, 'missed');
  assert.equal(judgeSecurity(clean, V('approve')).outcome, 'passed'); assert.equal(judgeSecurity(clean, V('changes', 'something')).outcome, 'falseBlock'); assert.ok(SECURITY_CASES.filter((c) => c.kind === 'defect').length >= 6 && SECURITY_CASES.filter((c) => c.kind === 'clean').length >= 3);
});
