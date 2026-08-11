import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  collectRuleDeclarations,
  duplicateRuleIds,
  KNOWN_RULE_ID_COLLISIONS,
  readLayeringSources,
  ruleIdCollisionFailures,
} from './rule-ids.ts';

const layeringDirectory = path.dirname(fileURLToPath(import.meta.url));

/** The exact collision #1750 is renaming away — the string the allowance names. */
const TRANSITIONAL_COLLISION =
  'R11 names contracts-implementation-authority and package-boundaries';

function failuresFor(sources: string[], allowed: readonly string[] = []): string[] {
  const declarations = collectRuleDeclarations(
    sources.map((source, index) => ({ path: `${index}.ts`, source })),
  );
  return ruleIdCollisionFailures({ declarations, allowed });
}

test('the layering rules currently in tree carry no unallowed collision', () => {
  const declarations = collectRuleDeclarations(readLayeringSources(layeringDirectory));
  assert.ok(declarations.length > 10, 'expected the layering rules to be discovered');
  assert.deepEqual(
    ruleIdCollisionFailures({ declarations, allowed: KNOWN_RULE_ID_COLLISIONS }),
    [],
  );
});

test('a collision nobody allowed fails, whichever order it lands in', () => {
  // Synthetic ids: a fixture naming real rules would read as an allocation to
  // anyone grepping for the next free number, which is how the collision this
  // gate exists for happened.
  const collision = ["rule: 'R99 first-claimant'", "const RULE = 'R99 second-claimant';"];
  const expected = [
    'two rules answer to one id: R99 names first-claimant and second-claimant. Allocate the next free number.',
  ];
  assert.deepEqual(failuresFor(collision), expected);
  assert.deepEqual(failuresFor([...collision].reverse()), expected, 'order must not matter');
});

test('an allowance expires with the collision it allows', () => {
  // The failure mode this replaces: after #1750 renames R11 apart, an allowance
  // still naming that collision would wave it back through if it returned.
  const cleanTree = [
    "rule: 'R11 package-boundaries'",
    "rule: 'R18 contracts-implementation-authority'",
  ];
  assert.deepEqual(failuresFor(cleanTree, [TRANSITIONAL_COLLISION]), [
    `stale allowance: "${TRANSITIONAL_COLLISION}" no longer occurs, so the entry admits a collision ` +
      'nobody is fixing. Delete it from KNOWN_RULE_ID_COLLISIONS.',
  ]);
});

test('reintroducing the transitional collision is rejected once the allowance is gone', () => {
  // The post-#1750 world: the list is empty, and the exact string it used to
  // carry buys nothing.
  const reintroduced = [
    "rule: 'R11 contracts-implementation-authority'",
    "rule: 'R11 package-boundaries'",
  ];
  assert.deepEqual(failuresFor(reintroduced, []), [
    `two rules answer to one id: ${TRANSITIONAL_COLLISION}. Allocate the next free number.`,
  ]);
  // And while the transition is live, the same collision is allowed exactly
  // because it is present — the allowance is never a blanket exemption.
  assert.deepEqual(failuresFor(reintroduced, [TRANSITIONAL_COLLISION]), []);
});

test('one rule declaring its id from several call sites is not a collision', () => {
  assert.deepEqual(
    duplicateRuleIds(
      collectRuleDeclarations([
        { path: 'a.ts', source: "rule: 'R98 many-emitters'" },
        { path: 'a.ts', source: "rule: 'R98 many-emitters'" },
      ]),
    ),
    [],
  );
});
