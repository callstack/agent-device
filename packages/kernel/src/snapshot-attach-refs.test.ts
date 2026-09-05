import { describe, expect, test } from 'vitest';
import { attachRefs, type RawSnapshotNode } from './snapshot.ts';

const node = (index: number, extra: Partial<RawSnapshotNode> = {}): RawSnapshotNode => ({
  index,
  ...extra,
});

describe('attachRefs', () => {
  test('preserves a backend-minted ref instead of re-minting a dense positional one', () => {
    // The web/agent-browser backend mints refs in tree order (non-dense — non-interactive
    // nodes are skipped). The first node's backend ref is e2 because e1 went to a node
    // that did not appear in the projected tree. Preserving it keeps the ref the agent
    // reads off the snapshot identical to the ref the backend resolves on the next action.
    const attached = attachRefs([node(0, { ref: 'e2' }), node(1, { ref: 'e3' })]);
    expect(attached.map((n) => n.ref)).toEqual(['e2', 'e3']);
    // index is preserved untouched — the positional identity is orthogonal to the ref.
    expect(attached.map((n) => n.index)).toEqual([0, 1]);
  });

  test('re-mints dense positional refs for nodes without a backend ref', () => {
    const attached = attachRefs([node(0), node(1, { ref: 'e7' }), node(2)]);
    expect(attached.map((n) => n.ref)).toEqual(['e1', 'e7', 'e3']);
  });
});
