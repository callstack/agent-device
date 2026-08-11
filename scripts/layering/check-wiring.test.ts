// The seam bin-alias-fast-path.test.ts calls out as untested — "the check.ts wiring that turns it
// into a violation" — checked directly: fixtures pin what each wiring mistake reports, and the last
// test holds the real check.ts to the same rule.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ruleWiringViolations } from './check-wiring.ts';

const GUARD_FILE = path.join(fileURLToPath(new URL('.', import.meta.url)), 'check.ts');

/**
 * The shape of check.ts's rule wiring, minus everything the guard does not read: one imported rule
 * and one local rule, spread into main()'s violation list. Fixtures vary one thing against this
 * baseline, so a test's subject is the line it changed.
 */
function guardFixture(violationList: string, prelude = ''): string {
  return `
import { checkPackageBoundaries } from './package-boundaries.ts';
${prelude}
function checkCycles(edges) {
  return [];
}

export function main() {
  const violations = [
${violationList}
  ];
  return report(violations);
}
`;
}

test('wiring each in-scope rule exactly once is clean', () => {
  const source = guardFixture('    ...checkCycles(edges),\n    ...checkPackageBoundaries(root),');
  assert.deepEqual(ruleWiringViolations(source), []);
});

test('a rule spread twice is named with its multiplier', () => {
  const source = guardFixture(
    '    ...checkCycles(edges),\n' +
      '    ...checkPackageBoundaries(root),\n' +
      '    ...checkCycles(edges),',
  );
  assert.deepEqual(ruleWiringViolations(source), [
    "checkCycles is spread into main()'s violation list 2 times, so every finding it reports is " +
      'printed and ::error-annotated 2 times. Keep one.',
  ]);
});

test('a rule that is never spread is reported as silently unenforced', () => {
  const source = guardFixture('    ...checkCycles(edges),');
  assert.deepEqual(ruleWiringViolations(source), [
    "checkPackageBoundaries is in scope but never spread into main()'s violation list, so the " +
      'rule it owns is silently unenforced — the guard still prints OK. Wire it in, delete it, ' +
      'or rename it if it is a helper rather than a rule.',
  ]);
});

test('an unwired rule is caught whether it is imported or declared here', () => {
  const source = guardFixture('    ...checkPackageBoundaries(root),', 'function checkNothing() {}');
  assert.deepEqual(
    ruleWiringViolations(source).map((message) => message.split(' ')[0]),
    ['checkNothing', 'checkCycles'],
  );
});

test('a type-only import carries no wiring obligation', () => {
  const source = guardFixture(
    '    ...checkCycles(edges),\n    ...checkPackageBoundaries(root),',
    "import type { checkShape } from './model.ts';",
  );
  assert.deepEqual(ruleWiringViolations(source), []);
});

test('the guard fails closed when the violation list is not where it looks', () => {
  const renamedList = ruleWiringViolations(
    guardFixture('    ...checkCycles(edges),').replace('const violations', 'const findings'),
  );
  const renamedMain = ruleWiringViolations(
    guardFixture('    ...checkCycles(edges),').replace('function main', 'function run'),
  );
  for (const violations of [renamedList, renamedMain]) {
    assert.equal(violations.length, 1);
    assert.match(violations[0]!, /cannot read the rule list/);
  }
});

test('check.ts wires every rule it has into main() exactly once', () => {
  assert.deepEqual(ruleWiringViolations(readFileSync(GUARD_FILE, 'utf8')), []);
});
