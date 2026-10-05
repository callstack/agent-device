import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import { findBestMatchesByLocator } from './find.ts';
import { parseSelectorChain } from './parse.ts';
import { resolveSelectorChain } from './resolve.ts';
import { formatRole } from '@agent-device/kernel/snapshot';

function makeNode(ref: string, label?: string, identifier?: string): SnapshotNode {
  return {
    index: Number(ref.replace('e', '')) || 0,
    ref,
    type: 'android.widget.TextView',
    kind: formatRole('android.widget.TextView'),
    label,
    identifier,
    rect: { x: 0, y: 0, width: 100, height: 20 },
  };
}

test('findBestMatchesByLocator returns all best-scored matches', () => {
  const nodes: SnapshotNode[] = [
    makeNode('e1', 'Continue'),
    makeNode('e2', 'Continue'),
    makeNode('e3', 'Continue later'),
  ];
  const result = findBestMatchesByLocator(nodes, 'label', 'Continue', { requireRect: true });
  assert.equal(result.score, 2);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0]?.ref, 'e1');
  assert.equal(result.matches[1]?.ref, 'e2');
});

// ── #3021: the `find role=` locator shares the matcher's kind vocabulary ──

function makeTypedNode(ref: string, type: string): SnapshotNode {
  return {
    index: Number(ref.replace('e', '')) || 0,
    ref,
    type,
    kind: formatRole(type),
    rect: { x: 0, y: 0, width: 100, height: 20 },
  };
}

function roleMatches(query: string, types: string[]) {
  const nodes = types.map((type, idx) => makeTypedNode(`e${idx + 1}`, type));
  return findBestMatchesByLocator(nodes, 'role', query);
}

test('find role= scores the coarse kind vocabulary exactly', () => {
  // Forward direction: the kind a snapshot publishes for the node.
  const text = roleMatches('text', ['android.widget.TextView', 'XCUIElementTypeStaticText']);
  assert.equal(text.score, 2);
  assert.deepEqual(
    text.matches.map((node) => node.ref),
    ['e1', 'e2'],
  );
});

test('find role= still scores legacy leaf spellings exactly during the window', () => {
  // Compatibility direction: `textview` was the old exact leaf for both class
  // spellings; the kind is context-coarse (`text` vs `text-view`), and the
  // window covers both.
  const textView = roleMatches('textview', ['android.widget.TextView', 'XCUIElementTypeTextView']);
  assert.equal(textView.score, 2);
  assert.deepEqual(
    textView.matches.map((node) => node.ref),
    ['e1', 'e2'],
  );
  const editText = roleMatches('edittext', ['android.widget.EditText']);
  assert.equal(editText.score, 2);
});

test('find role= keeps the historical substring score for legacy prefixes', () => {
  // Before #3021 the locator substring-matched the leaf (`statictext`.includes
  // ('static')); the alias window must keep that ranking, at score 1, not
  // promote it to an exact hit.
  const partial = roleMatches('static', ['XCUIElementTypeStaticText']);
  assert.equal(partial.score, 1);
  assert.equal(partial.matches[0]?.ref, 'e1');
});

test('find role= substring-scores the leaf segment, never a dotted kind package path', () => {
  // An unrecognized custom class keeps its full dotted lowercase as its kind.
  // The retired locator substring-matched the LAST segment only, so a released
  // `find role=fenix` refused `org.mozilla.fenix.ReaderView`; substringing the
  // whole kind would silently pull such nodes into the best set. Exact-kind
  // scoring still answers the full spelling when the query names it.
  const type = 'org.mozilla.fenix.ReaderView';
  assert.equal(roleMatches('fenix', [type]).score, 0);
  assert.equal(roleMatches('readerview', [type]).score, 2); // windowed legacy leaf
  assert.equal(roleMatches(type.toLowerCase(), [type]).score, 2); // the exact kind
});

test('find role= reaches AX-stripped queries through the exact window alias', () => {
  // Pinned parity decision (#3021 finding): the retired selector TERM stripped
  // a leading `AX` (`contracts` normalizeType) while the retired LOCATOR did
  // not, so `find role link click` on a macOS-helper `AXLink` node scored 1
  // there while `role=link` matched exactly. Adopting one shared authority
  // promotes the locator's AX-stripped query to the exact score — the locator
  // and the term cannot disagree about a node's role anymore.
  const axNode = roleMatches('link', ['AXLink']);
  assert.equal(axNode.score, 2);
  // The prefix-kept spelling keeps its historical exact score.
  assert.equal(roleMatches('axlink', ['AXLink']).score, 2);
});

test('find role= exact-scores whitespace-normalized spellings like the term does', () => {
  // Same parity rule for the term's other normalization step: the selector
  // term compared `normalizeText` on both sides, so `role="some widget"`
  // always matched the class `Some  Widget`; the retired locator scored that
  // query 0. One shared authority means the locator agrees — exact score, not
  // a substring rescue.
  assert.equal(roleMatches('some widget', ['Some  Widget']).score, 2);
});

test('find role= refuses sibling vocabulary words with no kind or alias match', () => {
  // Nearest-negative: a kind one dash away and an unrelated kind score 0.
  assert.equal(roleMatches('text-field', ['XCUIElementTypeStaticText']).score, 0);
  assert.equal(roleMatches('switch', ['XCUIElementTypeStaticText']).score, 0);
});

test('find role= does not widen a legacy leaf onto kind siblings that never carried it', () => {
  // The node-scoped window at the locator: `linearlayout` and `framelayout`
  // share the coarse kind `group`, but the legacy leaf was the EXACT class
  // leaf, and widening it onto the kind's other members would silently change
  // what a released `find role linearlayout` click targets.
  const both = roleMatches('linearlayout', [
    'android.widget.LinearLayout',
    'android.widget.FrameLayout',
  ]);
  assert.equal(both.score, 2);
  assert.deepEqual(
    both.matches.map((node) => node.ref),
    ['e1'],
  );
});

test('find role= and the role= selector term agree on every kind, alias, and negative', () => {
  // Locator/matcher parity is the issue's both-paths-reachable proof: the same
  // (query, type) pairs resolve through `resolveSelectorChain` exactly where
  // the locator scored them exactly 2.
  const cases: readonly [string, string][] = [
    ['text', 'XCUIElementTypeStaticText'],
    ['statictext', 'XCUIElementTypeStaticText'],
    ['textview', 'android.widget.TextView'],
    ['text-field', 'android.widget.EditText'],
    ['edittext', 'android.widget.EditText'],
    ['button', 'XCUIElementTypeButton'],
    ['imagebutton', 'XCUIElementTypeOther'], // kind of Other is `other`; must NOT match
    ['text-field', 'XCUIElementTypeStaticText'], // sibling kind: must NOT match
  ];
  for (const [query, type] of cases) {
    const nodes = [makeTypedNode('e1', type)];
    const locatorScore = findBestMatchesByLocator(nodes, 'role', query).score;
    const chain = parseSelectorChain(`role=${query}`);
    const resolved = resolveSelectorChain(nodes, chain, {
      platform: 'android',
      requireUnique: true,
    });
    assert.equal(
      Boolean(resolved),
      locatorScore === 2,
      `query "${query}" against type "${type}" diverged: locator score ${locatorScore}, selector ${resolved ? 'matched' : 'missed'}`,
    );
  }
});
