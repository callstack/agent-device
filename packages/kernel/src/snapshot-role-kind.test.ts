// #3021: the kernel-owned `role=` vocabulary shared by `kind`, the `role=`
// selector term, and the `find role=` locator. Everything is pinned through
// `roleSpellingsOfNode` — the ONE public reader both selector surfaces consume.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { attachRefs, formatRole, roleSpellingsOfNode } from './snapshot.ts';

test('roleSpellingsOfNode leads with the kind the capture published', () => {
  const [node] = attachRefs([{ index: 0, type: 'XCUIElementTypeStaticText' }]);
  assert.ok(node);
  assert.equal(node.kind, 'text');
  // A production node built by `attachRefs` matches on its published `kind`
  // first; the documented meaning of `role=` is that vocabulary.
  assert.deepEqual(roleSpellingsOfNode(node), ['text', 'statictext']);
});

test('roleSpellingsOfNode reuses formatRole for a node that predates kind publication', () => {
  // Fixtures that never route through `attachRefs` carry no `kind`; the reader
  // computes it with the SAME function that publishes it, not a second
  // normalization.
  assert.equal(roleSpellingsOfNode({ type: 'android.widget.EditText' })[0], 'text-field');
  assert.equal(roleSpellingsOfNode({})[0], formatRole('Element'));
});

test('a renamed leaf stays windowed on the node that carries it', () => {
  assert.deepEqual(roleSpellingsOfNode({ type: 'XCUIElementTypeStaticText' }), [
    'text',
    'statictext',
  ]);
  assert.deepEqual(roleSpellingsOfNode({ type: 'android.widget.EditText' }), [
    'text-field',
    'edittext',
  ]);
  assert.deepEqual(roleSpellingsOfNode({ type: 'android.widget.FrameLayout' }), [
    'group',
    'framelayout',
  ]);
  assert.deepEqual(roleSpellingsOfNode({ type: 'XCUIElementTypeSearchField' }), [
    'search',
    'searchfield',
  ]);
});

test('the window is node-scoped: sibling leaves of one coarse kind never alias each other', () => {
  // The nearest-negative that makes the alias window a window and not a
  // widening: `group` renames many leaves (`framelayout`, `linearlayout`,
  // `viewgroup`, …), and #3021 must not make `role=linearlayout` match a
  // FrameLayout node. Each node carries only ITS OWN old spelling.
  assert.deepEqual(roleSpellingsOfNode({ type: 'android.widget.LinearLayout' }), [
    'group',
    'linearlayout',
  ]);
  assert.ok(!roleSpellingsOfNode({ type: 'android.widget.FrameLayout' }).includes('linearlayout'));
});

test('the context-coarse `textview` leaf stays windowed on both spellings that emitted it', () => {
  // `formatRole` answers `text-view` for the desktop/iOS spelling and `text`
  // for the Android class; both nodes carried the matchable leaf `textview`.
  assert.deepEqual(roleSpellingsOfNode({ type: 'XCUIElementTypeTextView' }), [
    'text-view',
    'textview',
  ]);
  assert.deepEqual(roleSpellingsOfNode({ type: 'android.widget.TextView' }), ['text', 'textview']);
});

test('AX-prefixed class types carry the AX-stripped spelling the old normalizer matched', () => {
  // The macOS helper's `subrole ?? role` fallback emits raw `AX…` classes whose
  // canonical kind keeps the prefix while the retired matcher accepted the
  // AX-stripped spelling; renumbered leaves like `AXStaticText` window to the
  // leaf instead.
  assert.deepEqual(roleSpellingsOfNode({ type: 'AXFloatingWindow' }), [
    'axfloatingwindow',
    'floatingwindow',
  ]);
  assert.deepEqual(roleSpellingsOfNode({ type: 'AXUnknown' }), ['axunknown', 'unknown']);
  assert.deepEqual(roleSpellingsOfNode({ type: 'AXStaticText' }), ['axstatictext', 'statictext']);
});

test('the window replays the retired normalizer for arbitrary custom class names', () => {
  // The retired spelling took the last `.`-separated segment of any class, so
  // a released script could name a custom view class; the window must not
  // silently drop spellings formatRole's own leaf step would not produce.
  // (formatRole keeps the full dotted spelling as the kind for a non-Android
  // class it does not recognize; the old last-segment leaf windows beside it.)
  assert.deepEqual(roleSpellingsOfNode({ type: 'io.foo.app.MyButton' }), [
    'io.foo.app.mybutton',
    'mybutton',
  ]);
});

test('a kind that equals its leaf carries no alias of its own', () => {
  // The nearest-negative for the window itself: `button` and unmapped leaves
  // like `gridview` are both the leaf and the kind, so the window adds nothing
  // and no vocabulary entry leaks in.
  assert.deepEqual(roleSpellingsOfNode({ type: 'XCUIElementTypeButton' }), ['button']);
  assert.deepEqual(roleSpellingsOfNode({ type: 'android.widget.GridView' }), ['gridview']);
});

test('formatRole keeps its published vocabulary across the leaf-factorization', () => {
  // The #3021 refactor moved formatRole's leaf step into a shared helper; the
  // coarse answers every backend depends on must not move.
  assert.equal(formatRole('XCUIElementTypeStaticText'), 'text');
  assert.equal(formatRole('android.widget.TextView'), 'text');
  assert.equal(formatRole('XCUIElementTypeTextView'), 'text-view');
  assert.equal(formatRole('androidx.recyclerview.widget.RecyclerView'), 'list');
  assert.equal(formatRole('Button'), 'button');
  assert.equal(formatRole(''), 'element');
});
