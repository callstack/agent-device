import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  collectRuleDeclarations,
  duplicateRuleIds,
  KNOWN_RULE_ID_COLLISIONS,
  readLayeringSources,
} from './rule-ids.ts';

const layeringDirectory = path.dirname(fileURLToPath(import.meta.url));

test('no rule id names two rules beyond the collisions #1750 is renaming away', () => {
  const declarations = collectRuleDeclarations(readLayeringSources(layeringDirectory));
  assert.ok(declarations.length > 10, 'expected the layering rules to be discovered');
  const unexpected = duplicateRuleIds(declarations).filter(
    (collision) => !KNOWN_RULE_ID_COLLISIONS.includes(collision),
  );
  assert.deepEqual(unexpected, [], 'two rules answer to one id; allocate the next free number');
});

test('a collision is reported with both names, whichever order it lands in', () => {
  // The failure this gate exists for: two branches both take a free number.
  // Synthetic ids: a fixture naming real rules would read as an allocation to
  // anyone grepping for the next free number, which is how the collision this
  // gate exists for happened.
  const collision = [
    { path: 'a.ts', source: "rule: 'R99 first-claimant'" },
    { path: 'b.ts', source: "const RULE = 'R99 second-claimant';" },
  ];
  assert.deepEqual(duplicateRuleIds(collectRuleDeclarations(collision)), [
    'R99 names first-claimant and second-claimant',
  ]);
  assert.deepEqual(
    duplicateRuleIds(collectRuleDeclarations([...collision].reverse())),
    ['R99 names first-claimant and second-claimant'],
    'order of arrival must not change the verdict',
  );
});

test('one rule declaring its id from several call sites is not a collision', () => {
  // R7 and R12 legitimately emit from many places.
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
