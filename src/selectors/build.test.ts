import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode } from '../kernel/snapshot.ts';
import { buildSelectorChainForNode } from './build.ts';

function node(overrides: Partial<SnapshotNode>): SnapshotNode {
  return { ref: 'e1', index: 0, type: 'TextView', ...overrides };
}

// ---------------------------------------------------------------------------
// #1269: a shared `android:id/*` framework id (e.g. every Settings row's
// `android:id/title`) must not lead the recorded selector chain — leading
// with it lets an ambiguous match resolve via silent position-based
// disambiguation before the chain ever reaches the (unique) label clause.
// ---------------------------------------------------------------------------

test('buildSelectorChainForNode (#1269): a shared android:id/* id is demoted below the label clause', () => {
  const chain = buildSelectorChainForNode(
    node({ identifier: 'android:id/title', label: 'Network & internet' }),
    'android',
  );
  assert.equal(chain[0], 'role="textview" label="Network & internet"');
  // The demoted id survives only as the very last fallback entry.
  assert.equal(chain.at(-1), 'id="android:id/title"');
});

test('buildSelectorChainForNode (#1269): a unique (non-framework) resource id still leads the chain', () => {
  const chain = buildSelectorChainForNode(
    node({
      identifier: 'com.android.settings:id/network_and_internet_row',
      label: 'Network & internet',
    }),
    'android',
  );
  assert.equal(chain[0], 'id="com.android.settings:id/network_and_internet_row"');
});

test('buildSelectorChainForNode (#1269): a shared framework id with no label is kept — nothing else can discriminate', () => {
  const chain = buildSelectorChainForNode(node({ identifier: 'android:id/title' }), 'android');
  assert.equal(chain[0], 'id="android:id/title"');
});
