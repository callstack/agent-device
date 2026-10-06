// #3021: the package-owned `role=` vocabulary shared by the `role=` selector
// term and the `find role=` locator, pinned in `node.ts` where it lives. The
// canonical spelling is the published `kind` vocabulary; the deprecation
// window replays `@agent-device/contracts` `normalizeType` — the SAME function
// `buildSelectorChainForNode` records chains through — so a drift in that
// owner moves the window and the recorded spelling together instead of
// silently splitting replay.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachRefs, formatRole, type SnapshotNode } from '@agent-device/kernel/snapshot';
import { normalizeType } from '@agent-device/contracts/snapshot';
import { roleSpellingsOfNode } from './node.ts';

function bareNode(type: string): SnapshotNode {
  return { index: 0, ref: 'e1', type, kind: formatRole(type) };
}

test('roleSpellingsOfNode leads with the kind the capture published', () => {
  const [node] = attachRefs([{ index: 0, type: 'XCUIElementTypeStaticText' }]);
  assert.ok(node);
  assert.equal(node.kind, 'text');
  // A production node built by `attachRefs` matches on its published `kind`
  // first; the documented meaning of `role=` is that vocabulary.
  assert.deepEqual(roleSpellingsOfNode(node), ['text', 'statictext']);
});

test('roleSpellingsOfNode reads a published kind even when it diverges from the type', () => {
  // Distinguishes kind-reading from type-only matching: a node whose `kind`
  // is NOT what formatRole(type) would derive must lead with the published
  // kind, with the retired spelling riding only as the window. A regression
  // to deriving the canonical spelling from `type` fails here even though the
  // window spelling rides along in both directions.
  assert.deepEqual(roleSpellingsOfNode({ ...bareNode('XCUIElementTypeButton'), kind: 'text' }), [
    'text',
    'button',
  ]);
});

test('roleSpellingsOfNode reuses formatRole for a node that predates kind publication', () => {
  // Fixtures that never route through `attachRefs` carry no `kind`; the reader
  // computes it with the SAME function that publishes it, not a second
  // normalization.
  assert.equal(
    roleSpellingsOfNode({ index: 0, ref: 'e1', type: 'android.widget.EditText' })[0],
    'text-field',
  );
  assert.equal(roleSpellingsOfNode({ index: 0, ref: 'e1' })[0], formatRole('Element'));
});

test('a renamed leaf stays windowed on the node that carries it', () => {
  assert.deepEqual(roleSpellingsOfNode(bareNode('XCUIElementTypeStaticText')), [
    'text',
    'statictext',
  ]);
  assert.deepEqual(roleSpellingsOfNode(bareNode('android.widget.EditText')), [
    'text-field',
    'edittext',
  ]);
  assert.deepEqual(roleSpellingsOfNode(bareNode('android.widget.FrameLayout')), [
    'group',
    'framelayout',
  ]);
  assert.deepEqual(roleSpellingsOfNode(bareNode('XCUIElementTypeSearchField')), [
    'search',
    'searchfield',
  ]);
});

test('the window is node-scoped: sibling leaves of one coarse kind never alias each other', () => {
  // The nearest-negative that makes the window a window and not a widening:
  // `group` renames many leaves (`framelayout`, `linearlayout`, `viewgroup`,
  // …), and #3021 must not make `role=linearlayout` match a FrameLayout node.
  // Each node carries only ITS OWN retired spelling.
  assert.deepEqual(roleSpellingsOfNode(bareNode('android.widget.LinearLayout')), [
    'group',
    'linearlayout',
  ]);
  assert.ok(!roleSpellingsOfNode(bareNode('android.widget.FrameLayout')).includes('linearlayout'));
});

test('the context-coarse `textview` leaf stays windowed on both spellings that emitted it', () => {
  // `formatRole` answers `text-view` for the desktop/iOS spelling and `text`
  // for the Android class; both nodes carried the matchable leaf `textview`.
  assert.deepEqual(roleSpellingsOfNode(bareNode('XCUIElementTypeTextView')), [
    'text-view',
    'textview',
  ]);
  assert.deepEqual(roleSpellingsOfNode(bareNode('android.widget.TextView')), ['text', 'textview']);
});

test('AX-prefixed class types carry the AX-stripped spelling the old matcher accepted', () => {
  // The macOS helper's `subrole ?? role` fallback emits raw `AX…` classes
  // whose canonical kind keeps the prefix while the retired matcher accepted
  // the AX-stripped spelling; renumbered leaves like `AXStaticText` window to
  // the leaf instead.
  assert.deepEqual(roleSpellingsOfNode(bareNode('AXFloatingWindow')), [
    'axfloatingwindow',
    'floatingwindow',
  ]);
  assert.deepEqual(roleSpellingsOfNode(bareNode('AXUnknown')), ['axunknown', 'unknown']);
  // `axstatictext` is NOT a ROLE_LABELS key, so the kind keeps the prefix and
  // the window carries the AX-stripped leaf.
  assert.deepEqual(roleSpellingsOfNode(bareNode('AXStaticText')), ['axstatictext', 'statictext']);
});

test('the window replays the owner normalizer for arbitrary custom class names', () => {
  // `normalizeType` took the last `.`/`/`-separated segment of any class, so a
  // released script could name a custom view class; the window rides that
  // owner's answer directly.
  // (formatRole keeps the full dotted spelling as the kind for a non-Android
  // class it does not recognize; the last-segment spelling windows beside it.)
  assert.deepEqual(roleSpellingsOfNode(bareNode('io.foo.app.MyButton')), [
    'io.foo.app.mybutton',
    'mybutton',
  ]);
});

test('a kind that equals its retired spelling carries no window entry', () => {
  // The nearest-negative for the window itself: `button` and unmapped leaves
  // like `gridview` are both the retired spelling and the kind, so the window
  // adds nothing and no vocabulary entry leaks in.
  assert.deepEqual(roleSpellingsOfNode(bareNode('XCUIElementTypeButton')), ['button']);
  assert.deepEqual(roleSpellingsOfNode(bareNode('android.widget.GridView')), ['gridview']);
});

test('the window IS normalizeType: drift in the owner moves the window and the recorded chain together', () => {
  // The #3021 review rule — one owner for the legacy role spelling: the window
  // reads `@agent-device/contracts` `normalizeType` directly, the SAME
  // function `buildSelectorChainForNode` records `role=` chains through. This
  // pin fails the moment the window grows a private copy: for any backend type
  // the window's second entry must equal `normalizeType(type)` whenever that
  // differs from the kind, and equal nothing when it does not.
  const TYPES = [
    'XCUIElementTypeStaticText',
    'XCUIElementTypeButton',
    'android.widget.TextView',
    'androidx.recyclerview.widget.RecyclerView',
    'com.google.android.material.textfield.TextInputEditText',
    'AXWebArea',
    'AXUnknown',
    'StaticText',
    'a.b/c',
    'SearchField',
  ];
  for (const type of TYPES) {
    const spellings = roleSpellingsOfNode(bareNode(type));
    const retired = normalizeType(type);
    const kind = formatRole(type);
    if (retired && retired !== kind) {
      assert.deepEqual(spellings, [kind, retired], `window drifted for ${type}`);
    } else {
      assert.deepEqual(spellings, [kind], `spurious window entry for ${type}`);
    }
  }
});
