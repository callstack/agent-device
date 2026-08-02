/**
 * #1478 P5 step 2: cell 6 — how the id identity tier is demoted.
 *
 * `idMatchCountInTree` / `demoteNonUniqueLocalIdentity` are the ONE shared
 * uniqueness predicate behind both id-demotion sites (the `target-v1`
 * identity tuple `session-target-evidence.ts` writes at record time, and the
 * selector chain `buildSelectorChainForNode` builds — see
 * `src/selectors/build.test.ts` for that consumer's own coverage). Neither of
 * those consumer tests exercises this pair of functions directly; this file
 * pins the shared predicate itself, so a future replay-port `resolveRecordedTarget`
 * that re-derives identity demotion a different way (or drops it) fails here
 * first.
 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildNodes } from '../../__tests__/test-utils/snapshot-builders.ts';
import {
  demoteNonUniqueLocalIdentity,
  idMatchCountInTree,
  readNodeLocalIdentity,
} from '../target-identity-node.ts';

function sharedIdRows() {
  return buildNodes([
    {
      index: 0,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Network & internet',
      rect: { x: 0, y: 100, width: 300, height: 48 },
    },
    {
      index: 1,
      type: 'TextView',
      identifier: 'android:id/title',
      label: 'Apps',
      rect: { x: 0, y: 148, width: 300, height: 48 },
    },
    {
      index: 2,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      rect: { x: 0, y: 196, width: 40, height: 20 },
    },
  ]);
}

test('P5 port cell 6: idMatchCountInTree counts every node sharing the canonical id, independent of role/label/position', () => {
  const nodes = sharedIdRows();
  assert.equal(idMatchCountInTree(nodes, 'android:id/title'), 2);
  assert.equal(idMatchCountInTree(nodes, 'save'), 1);
  assert.equal(idMatchCountInTree(nodes, 'does-not-exist'), 0);
});

test('P5 port cell 6: demoteNonUniqueLocalIdentity drops ONLY the id tier, and only when the id is shared', () => {
  const nodes = sharedIdRows();

  const sharedIdentity = readNodeLocalIdentity(nodes[0]!);
  assert.equal(sharedIdentity.id, 'android:id/title');
  const demoted = demoteNonUniqueLocalIdentity(sharedIdentity, nodes);
  assert.deepEqual(demoted, { role: 'textview', label: 'Network & internet' });
  assert.equal('id' in demoted, false, 'a non-unique id must not survive demotion');

  const uniqueIdentity = readNodeLocalIdentity(nodes[2]!);
  assert.equal(uniqueIdentity.id, 'save');
  const kept = demoteNonUniqueLocalIdentity(uniqueIdentity, nodes);
  assert.deepEqual(kept, uniqueIdentity, 'a unique id must be preserved unchanged');
});

test('P5 port cell 6: an identity with no recorded id is a pass-through — demotion never invents an id-based branch for it', () => {
  const nodes = buildNodes([{ index: 0, type: 'Button', label: 'Unlabeled row' }]);
  const identity = readNodeLocalIdentity(nodes[0]!);
  assert.equal(identity.id, undefined);
  assert.deepEqual(demoteNonUniqueLocalIdentity(identity, nodes), identity);
});
