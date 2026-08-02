import { test } from 'vitest';
import assert from 'node:assert/strict';
import { matchesAncestryPrefix, matchesLocalIdentity } from '../target-identity.ts';

// The `# agent-device:target-v1` SERDE (serialize/parse, normalization,
// bounds) moved to `@agent-device/ad-script` — see
// `packages/ad-script/src/internal/__tests__/target-annotation-serde.test.ts`.
// This file keeps only the record/replay-shared CLASSIFICATION core that
// stays in `src/replay/target-identity.ts` (#1478 P5 scoping dossier).

// ---------------------------------------------------------------------------
// Leaf-anchored ancestry prefix matching: root-side truncation + inserted
// wrapper mismatch
// ---------------------------------------------------------------------------

test('matchesAncestryPrefix accepts an observed chain that is a superset on the root side (truncation)', () => {
  const recorded = [{ role: 'toolbar', label: 'Editor' }];
  const observedFullDepth = [
    { role: 'toolbar', label: 'Editor' },
    { role: 'window' },
    { role: 'application' },
  ];
  assert.equal(matchesAncestryPrefix(observedFullDepth, recorded), true);
});

test('matchesAncestryPrefix rejects an inserted wrapper ancestor (structure is part of identity)', () => {
  const recorded = [{ role: 'toolbar', label: 'Editor' }, { role: 'window' }];
  // A new wrapper view inserted directly above the target shifts every entry
  // one level down — the leaf-anchored prefix no longer matches.
  const observedWithInsertedWrapper = [
    { role: 'view' },
    { role: 'toolbar', label: 'Editor' },
    { role: 'window' },
  ];
  assert.equal(matchesAncestryPrefix(observedWithInsertedWrapper, recorded), false);
});

test('matchesAncestryPrefix rejects a shorter observed chain', () => {
  const recorded = [{ role: 'toolbar' }, { role: 'window' }];
  assert.equal(matchesAncestryPrefix([{ role: 'toolbar' }], recorded), false);
});

test('matchesAncestryPrefix leaves an unconstrained (absent) recorded label unconstrained', () => {
  const recorded = [{ role: 'toolbar' }];
  assert.equal(matchesAncestryPrefix([{ role: 'toolbar', label: 'anything' }], recorded), true);
});

// ---------------------------------------------------------------------------
// Local identity
// ---------------------------------------------------------------------------

test('matchesLocalIdentity: a recorded id never matches a node without that id', () => {
  assert.equal(matchesLocalIdentity({ role: 'button' }, { id: 'save', role: 'button' }), false);
});

test('matchesLocalIdentity: with no recorded id, role+label must both match, absent-absent counts as equal', () => {
  assert.equal(matchesLocalIdentity({ role: 'button' }, { role: 'button' }), true);
  assert.equal(matchesLocalIdentity({ role: 'button', label: 'Save' }, { role: 'button' }), false);
});
