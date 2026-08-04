import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  demoteNonUniqueLocalIdentity,
  idMatchCountInTree,
  matchesAncestryPrefix,
  matchesLocalIdentity,
  readNodeLocalIdentity,
} from '../target-annotation-identity.ts';

// The `# agent-device:target-v1` SERDE (serialize/parse, normalization,
// bounds) lives alongside this in `target-annotation-serde.ts` — see
// `packages/ad-script/src/internal/__tests__/target-annotation-serde.test.ts`.
// This file covers the local-identity + ancestry-prefix matching primitives.
// The record/replay-shared CLASSIFICATION core built on top of them
// (`classifyTargetBindingMatch`) is engine-owned policy and stays in
// `@agent-device/ad-replay`'s `target-identity.ts` (#1478 P5 review).

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

// ---------------------------------------------------------------------------
// Shared id demotion. `idMatchCountInTree` / `demoteNonUniqueLocalIdentity`
// are the ONE shared uniqueness predicate behind both id-demotion sites (the
// `target-v1` identity tuple `session-target-evidence.ts` writes at record
// time, and the selector chain `buildSelectorChainForNode` builds — see
// `src/__tests__/selectors-build.test.ts` for that consumer's own coverage). Neither
// consumer test exercises the pair directly; these tests pin the shared
// predicate itself, so a re-derivation of identity demotion that drops or
// scopes the uniqueness rule fails here first.
// ---------------------------------------------------------------------------

function sharedIdRows(): RawSnapshotNode[] {
  return [
    {
      index: 0,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Network & internet',
    },
    {
      index: 1,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Apps',
    },
    { index: 2, type: 'Button', identifier: 'save', label: 'Save' },
  ];
}

test('idMatchCountInTree counts every node sharing the canonical id, independent of role or label', () => {
  const nodes = sharedIdRows();
  assert.equal(idMatchCountInTree(nodes, 'android:id/title'), 2);
  assert.equal(idMatchCountInTree(nodes, 'save'), 1);
  assert.equal(idMatchCountInTree(nodes, 'does-not-exist'), 0);
});

test('demoteNonUniqueLocalIdentity drops only a shared id tier', () => {
  const nodes = sharedIdRows();

  const sharedIdentity = readNodeLocalIdentity(nodes[0]!);
  assert.equal(sharedIdentity.id, 'android:id/title');
  assert.deepEqual(demoteNonUniqueLocalIdentity(sharedIdentity, nodes), {
    role: 'textview',
    label: 'Network & internet',
  });

  const uniqueIdentity = readNodeLocalIdentity(nodes[2]!);
  assert.equal(uniqueIdentity.id, 'save');
  assert.deepEqual(demoteNonUniqueLocalIdentity(uniqueIdentity, nodes), uniqueIdentity);
});

test('demoteNonUniqueLocalIdentity passes through identities without an id', () => {
  const nodes: RawSnapshotNode[] = [{ index: 0, type: 'Button', label: 'Unlabeled row' }];
  const identity = readNodeLocalIdentity(nodes[0]!);
  assert.equal(identity.id, undefined);
  assert.deepEqual(demoteNonUniqueLocalIdentity(identity, nodes), identity);
});
