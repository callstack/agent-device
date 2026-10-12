import { describe, expect, test } from 'vitest';
import {
  attachRefs,
  hasSnapshotRef,
  snapshotRefBodies,
  snapshotRefMinting,
  type RawSnapshotNode,
} from './snapshot.ts';

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

  test('mints nothing for a node the backend left unaddressed', () => {
    // A backend-issued tree is the web case: the backend resolves an action against refs of its own,
    // so a ref minted here would either name a different element or nothing at all. The node stays
    // in the tree — that is how its text reaches a reader — and simply carries no address.
    const attached = attachRefs(
      [node(0, { ref: 'e2' }), node(1), node(2, { ref: 'e4' })],
      'backend-issued',
    );

    expect(attached.map((n) => n.ref)).toEqual(['e2', undefined, 'e4']);
    // No `ref` key at all, so a JSON response says "nothing addresses this" instead of "undefined".
    expect(Object.hasOwn(attached[1]!, 'ref')).toBe(false);
    expect(attached.map((n) => n.index)).toEqual([0, 1, 2]);
  });

  test('publishes the presenter role as kind, for Android and Apple vocabularies, on every node (#2656)', () => {
    const attached = attachRefs([
      node(0, { type: 'android.widget.Button' }),
      node(1, { type: 'XCUIElementTypeButton' }),
      node(2, { type: undefined }),
    ]);
    expect(attached.map((n) => n.kind)).toEqual(['button', 'button', 'element']);
  });
});

describe('snapshotRefMinting', () => {
  test('a web capture owns its ref namespace', () => {
    expect(snapshotRefMinting({ backend: 'web', producer: 'agent-browser' })).toBe(
      'backend-issued',
    );
  });

  test('every other producer is minted positionally, and a capture with no provenance too', () => {
    expect(snapshotRefMinting({ backend: 'xctest', producer: 'apple-runner' })).toBe('dense');
    expect(snapshotRefMinting({ backend: 'android', producer: 'appium-source' })).toBe('dense');
    expect(snapshotRefMinting(undefined)).toBe('dense');
  });
});

describe('snapshot addressability', () => {
  const attached = attachRefs(
    [node(0, { ref: 'e2' }), node(1), node(2, { ref: 'e4' })],
    'backend-issued',
  );

  test('hasSnapshotRef narrows the ref for a caller that publishes it as an address', () => {
    expect(attached.filter(hasSnapshotRef).map((n) => n.ref)).toEqual(['e2', 'e4']);
    expect(attached.filter((n) => !hasSnapshotRef(n)).map((n) => n.index)).toEqual([1]);
  });

  test('snapshotRefBodies collects the refs a node set can be re-addressed by', () => {
    expect(snapshotRefBodies(attached)).toEqual(['e2', 'e4']);
    expect(snapshotRefBodies([])).toEqual([]);
  });
});
