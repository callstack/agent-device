import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SELECTOR_RESOLUTION_POLICIES, selectorResolutionKnobs } from './resolution-policy.ts';

/**
 * `selectorResolutionKnobs` is package-private (#1630): the façade exports no
 * resolver that accepts `requireUnique`/`disambiguateAmbiguous`, so this is the
 * only place in the repo that names them and the only place a knob-vs-row
 * mismatch can be introduced. The row-level BEHAVIOR each mapping produces is
 * pinned separately, through the public interface, in
 * src/commands/interaction/runtime/__tests__/resolution-policy-parity.test.ts.
 */
test('knobs stay consistent with the ambiguity each knob-backed row names', () => {
  for (const [name, policy] of Object.entries(SELECTOR_RESOLUTION_POLICIES)) {
    if (policy.ambiguity === 'reject-candidates') continue;
    const knobs = selectorResolutionKnobs(policy);
    assert.equal(knobs.requireRect, policy.requireRect, name);
    if (policy.ambiguity === 'first-match') {
      assert.equal(knobs.requireUnique, false, name);
    } else {
      assert.equal(knobs.requireUnique, true, name);
      assert.equal(knobs.disambiguateAmbiguous, policy.ambiguity === 'disambiguate', name);
    }
  }
});
