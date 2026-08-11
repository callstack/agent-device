import assert from 'node:assert/strict';
import { test } from 'vitest';
import { makeSnapshotState } from '../../../__tests__/test-utils/index.ts';
import {
  ELEMENT14_DISTINCT_SUBTREE_NODES,
  EQUIVALENT_WRAPPER_CHAIN_NODES,
} from '../../../core/interaction-targeting.fixtures.ts';
import { SELECTOR_PIPELINE_POLICIES } from '../../../core/selector-pipeline-policy.ts';
import { resolveActionSelector } from './selector-action-resolution.ts';

test('mutating selector collapses a wrapper chain that resolves to one actionable node', () => {
  const snapshot = makeSnapshotState(EQUIVALENT_WRAPPER_CHAIN_NODES);

  const result = resolveActionSelector(
    snapshot.nodes,
    'label="Chat"',
    'ios',
    SELECTOR_PIPELINE_POLICIES.promotedTarget,
  );

  assert.equal(result?.node.index, 1);
  assert.equal(result?.matches, 3);
  assert.equal(result?.disambiguation?.tiebreak, 'structural-equivalence');
});

test('mutating selector rejects element-14-shaped matches in distinct subtrees with candidates', () => {
  const snapshot = makeSnapshotState(ELEMENT14_DISTINCT_SUBTREE_NODES);

  assert.throws(
    () =>
      resolveActionSelector(
        snapshot.nodes,
        'label="Team Standup"',
        'ios',
        SELECTOR_PIPELINE_POLICIES.promotedTarget,
      ),
    (error: unknown) => {
      assert.equal((error as { code?: unknown }).code, 'AMBIGUOUS_MATCH');
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.matches, 4);
      assert.deepEqual(details?.candidates, [
        '@e2 [text] "Team Standup"',
        '@e3 [text-field] "Team Standup"',
        '@e4 [cell] "Team Standup"',
        '@e5 [button] "Team Standup"',
      ]);
      return true;
    },
  );
});
