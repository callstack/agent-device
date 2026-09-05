// A rule policy module can compute violations correctly and still never run, if its entry in
// LAYERING_RULES is missing or its id is missing from LAYERING_RULE_IDS. The registry makes
// duplicate registration unrepresentable on its own (an object holds a key once, and oxlint's
// no-dupe-keys rejects the attempt), so what is left to check is the other direction: that the
// catalog and the registry still describe the same set of rules.
// scripts/ is outside tsconfig.json's `include`, so the Record's exhaustiveness is an editor
// signal, not a CI gate — this test is what fails the build when wiring goes missing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LAYERING_RULE_IDS, LAYERING_RULES } from './check.ts';

test('every catalogued rule is registered, and nothing else is', () => {
  assert.deepEqual(Object.keys(LAYERING_RULES), [...LAYERING_RULE_IDS]);
});

test('every registered rule is callable, so no entry is a stale reference', () => {
  for (const id of LAYERING_RULE_IDS) {
    assert.equal(typeof LAYERING_RULES[id], 'function', `${id} is not callable`);
  }
});
