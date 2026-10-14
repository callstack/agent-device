import { describe, expect, test } from 'vitest';
import {
  attachRefs,
  hasSnapshotRef,
  snapshotRefBodies,
  snapshotRefMinting,
  type RawSnapshotNode,
  type SnapshotProvenance,
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
  test('the producer that owns its ref namespace gets backend-issued minting', () => {
    expect(snapshotRefMinting({ backend: 'web', producer: 'agent-browser' })).toBe(
      'backend-issued',
    );
  });

  // The mode keys on the producer, never on the platform channel: several producers can feed one
  // channel (`xctest` alone has four) and only some of them mint refs of their own. A web adapter
  // added later — a webdriver- or CDP-backed one — would arrive on the `web` channel minting
  // nothing, and would need dense numbering to keep every node addressable as it does today.
  test.each([
    { backend: 'xctest', producer: 'apple-runner' },
    { backend: 'xctest', producer: 'simulator-ax-bridge' },
    { backend: 'xctest', producer: 'appium-source' },
    { backend: 'xctest', producer: 'limrun-ios-tree' },
    { backend: 'android', producer: 'android-uiautomator' },
    { backend: 'android', producer: 'appium-source' },
    { backend: 'harmonyos-arkui', producer: 'harmonyos-uitest' },
    { backend: 'macos-helper', producer: 'macos-helper' },
    { backend: 'linux-atspi', producer: 'linux-atspi' },
  ] satisfies readonly SnapshotProvenance[])(
    '$backend/$producer is minted positionally',
    (provenance) => {
      expect(snapshotRefMinting(provenance)).toBe('dense');
    },
  );

  test('a capture with no provenance is minted positionally', () => {
    expect(snapshotRefMinting(undefined)).toBe('dense');
    expect(snapshotRefMinting({})).toBe('dense');
    // Type-level half of the producer-keyed decision: a channel cannot be handed over on its own,
    // so this function never has to guess which producer published a tree. `pnpm typecheck` fails
    // the moment the parameter widens back to a partial pair.
    // @ts-expect-error the minting mode needs the whole provenance pair, not the channel alone
    snapshotRefMinting({ backend: 'web' });
  });

  test('a second producer on the web channel keeps dense numbering', () => {
    // Forward-looking regression for the axis itself, not for a pair the table admits today: the
    // provenance table has exactly one web producer, so a webdriver- or CDP-backed adapter is not
    // expressible yet and has to be widened through here. When it lands, `agent-browser` is the
    // entry that owns its refs and nothing else on the channel does — the case a channel check
    // would get wrong by handing it `backend-issued` and stripping every ref in its tree.
    const secondWebAdapter = {
      backend: 'web',
      producer: 'webdriver-source',
    } as unknown as SnapshotProvenance;
    expect(snapshotRefMinting(secondWebAdapter)).toBe('dense');
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
