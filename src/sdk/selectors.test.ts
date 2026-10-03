import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildNodes } from '../__tests__/test-utils/snapshot-builders.ts';
import {
  findSelectorChainMatch,
  listSelectorChainMatches,
  parseSelectorChain,
  resolveSelectorChain,
} from './selectors.ts';

// Public-entry contract (#3180), through `./selectors.ts` rather than a deep
// import: every node the winning alternative matches, on the same snapshot a
// consumer applies its own strictness to.

const loginNodes = () =>
  buildNodes([
    { index: 0, type: 'Window' },
    {
      index: 1,
      type: 'Button',
      label: 'Continue',
      identifier: 'auth_continue',
      rect: { x: 0, y: 80, width: 200, height: 44 },
      hittable: true,
    },
    { index: 2, type: 'Text', label: 'Skip', rect: { x: 0, y: 124, width: 200, height: 20 } },
    {
      index: 3,
      type: 'Button',
      label: 'Continue',
      identifier: 'secondary_continue',
      rect: { x: 0, y: 140, width: 200, height: 44 },
      hittable: true,
    },
    // Matched by default; refused when the caller requires geometry.
    { index: 4, type: 'Button', label: 'Continue', hittable: true },
  ]);

test('listSelectorChainMatches returns every node of the winning alternative, in snapshot order (#3180)', () => {
  const nodes = loginNodes();
  const match = listSelectorChainMatches(nodes, parseSelectorChain('label="Continue"'), {
    platform: 'ios',
  });
  assert.ok(match);
  assert.equal(match.selectorIndex, 0);
  assert.equal(match.selector.raw, 'label="Continue"');
  assert.deepEqual(
    match.matchedNodes.map((node) => node.ref),
    ['e2', 'e4', 'e5'],
  );
  // Identity, not a copy: consumers compare against their own snapshot.
  assert.equal(match.matchedNodes[0], nodes[1]);
});

test('listSelectorChainMatches reports several matches where resolveSelectorChain refuses, from the same chain', () => {
  const nodes = loginNodes();
  const chain = parseSelectorChain('label="Continue"');
  assert.equal(
    resolveSelectorChain(nodes, chain, { platform: 'ios', requireUnique: true }),
    null,
    'uniqueness refusal must not remove the matched nodes from the list',
  );
  const match = listSelectorChainMatches(nodes, chain, { platform: 'ios' });
  assert.equal(match?.matchedNodes.length, 3);
});

test('listSelectorChainMatches walks to the first alternative that matches, as find does and a uniqueness-refusing resolve does not', () => {
  const nodes = loginNodes();
  const match = listSelectorChainMatches(
    nodes,
    parseSelectorChain('label="Absent" || id=auth_continue'),
    { platform: 'ios' },
  );
  assert.ok(match);
  assert.equal(match.selectorIndex, 1);
  assert.deepEqual(
    match.matchedNodes.map((node) => node.ref),
    ['e2'],
  );
  // Both alternatives match: `find` shares this answer, a default
  // `resolveSelectorChain` refuses ambiguous alternative 0 and names 1.
  assert.equal(
    findSelectorChainMatch(nodes, parseSelectorChain('label="Continue" || id=auth_continue'), {
      platform: 'ios',
    })?.selectorIndex,
    0,
  );
  assert.equal(
    resolveSelectorChain(nodes, parseSelectorChain('label="Continue" || id=auth_continue'), {
      platform: 'ios',
    })?.selectorIndex,
    1,
  );
  const both = listSelectorChainMatches(
    nodes,
    parseSelectorChain('label="Continue" || id=auth_continue'),
    { platform: 'ios' },
  );
  assert.equal(both?.selectorIndex, 0);
  assert.deepEqual(
    both?.matchedNodes.map((node) => node.ref),
    ['e2', 'e4', 'e5'],
  );
  assert.equal(
    listSelectorChainMatches(nodes, parseSelectorChain('label="Absent"'), { platform: 'ios' }),
    null,
  );
});

test('listSelectorChainMatches honors requireRect against the same geometry the resolver sees', () => {
  const nodes = loginNodes();
  const match = listSelectorChainMatches(nodes, parseSelectorChain('label="Continue"'), {
    platform: 'ios',
    requireRect: true,
  });
  assert.deepEqual(
    match?.matchedNodes.map((node) => node.ref),
    ['e2', 'e4'],
  );
});

test('listSelectorChainMatches lets requireRect change WHICH alternative wins, not just its members', () => {
  // `requireRect` removes candidates BEFORE alternative selection, so the walk
  // can move to a later alternative instead of reporting an empty first one.
  const nodes = buildNodes([
    { index: 0, type: 'Button', label: 'NoRect' },
    { index: 1, type: 'Button', identifier: 'foo', rect: { x: 0, y: 10, width: 10, height: 10 } },
  ]);
  const chain = parseSelectorChain('label="NoRect" || id=foo');
  assert.equal(
    listSelectorChainMatches(nodes, chain, { platform: 'ios' })?.selectorIndex,
    0,
    'without the geometry requirement the first alternative wins',
  );
  const required = listSelectorChainMatches(nodes, chain, {
    platform: 'ios',
    requireRect: true,
  });
  assert.equal(required?.selectorIndex, 1);
  assert.deepEqual(
    required?.matchedNodes.map((node) => node.ref),
    ['e2'],
  );
});

test('listSelectorChainMatches returns null for an empty chain and for a total miss', () => {
  const nodes = loginNodes();
  // No alternative to win, and an empty match set is not representable.
  assert.equal(
    listSelectorChainMatches(nodes, { raw: '', selectors: [] }, { platform: 'ios' }),
    null,
  );
});

test('listSelectorChainMatches returns nodes in snapshot-array order, not index order', () => {
  // Array order, not `index` order: the answer follows the snapshot passed in.
  const nodes = buildNodes([
    { index: 5, type: 'Button', label: 'M' },
    { index: 2, type: 'Button', label: 'M' },
  ]);
  assert.deepEqual(
    nodes.map((node) => node.ref),
    ['e1', 'e2'],
  );
  const match = listSelectorChainMatches(nodes, parseSelectorChain('label="M"'), {
    platform: 'ios',
  });
  assert.deepEqual(
    match?.matchedNodes.map((node) => node.ref),
    ['e1', 'e2'],
  );
  assert.deepEqual(
    match?.matchedNodes.map((node) => node.index),
    [5, 2],
  );
});

test('listSelectorChainMatches uses agent-device term semantics (#3180)', () => {
  // `hittable` requires an explicit true, so the non-hittable row cannot lead.
  const hittableNodes = buildNodes([
    { index: 0, type: 'Button', label: 'Refresh' },
    {
      index: 1,
      type: 'Button',
      label: 'Refresh',
      rect: { x: 0, y: 40, width: 100, height: 40 },
      hittable: true,
    },
  ]);
  const hittable = listSelectorChainMatches(
    hittableNodes,
    parseSelectorChain('hittable=true label="Refresh"'),
    { platform: 'ios' },
  );
  assert.deepEqual(
    hittable?.matchedNodes.map((node) => node.ref),
    ['e2'],
  );

  // `text` is extractNodeText — the FIRST non-empty of label/value/identifier —
  // so e2, whose label wins with a different value, does not match.
  const textNodes = buildNodes([
    { index: 0, type: 'Button', label: 'Sign in' },
    { index: 1, type: 'Button', label: 'Other', value: 'Sign in' },
  ]);
  const text = listSelectorChainMatches(textNodes, parseSelectorChain('text="Sign in"'), {
    platform: 'android',
  });
  assert.deepEqual(
    text?.matchedNodes.map((node) => node.ref),
    ['e1'],
  );

  // `role` matches the NORMALIZED native class, not the raw type string.
  const roleNodes = buildNodes([
    { index: 0, type: 'XCUIElementTypeButton', label: 'OK' },
    { index: 1, type: 'XCUIElementTypeSwitch', label: 'Wi-Fi' },
  ]);
  const role = listSelectorChainMatches(roleNodes, parseSelectorChain('role="button"'), {
    platform: 'ios',
  });
  assert.deepEqual(
    role?.matchedNodes.map((node) => node.ref),
    ['e1'],
  );

  // `editable` is fillable type + enabled: a TextView role="textbox" is not
  // fillable, and a disabled EditText is not enabled.
  const editableNodes = buildNodes([
    { index: 0, type: 'android.widget.EditText', label: 'Name', enabled: true },
    { index: 1, type: 'android.widget.TextView', label: 'Note', role: 'textbox' },
    { index: 2, type: 'android.widget.EditText', label: 'Disabled', enabled: false },
  ]);
  const editable = listSelectorChainMatches(editableNodes, parseSelectorChain('editable=true'), {
    platform: 'android',
  });
  assert.deepEqual(
    editable?.matchedNodes.map((node) => node.ref),
    ['e1'],
  );

  // `visible` is isNodeVisible: hittable OR a non-empty rect. e1 exercises the
  // hittable arm with a zero-size rect, e2 the rect arm while non-hittable, and
  // e3 has neither, which is what `hidden=true` names.
  const visibleNodes = buildNodes([
    {
      index: 0,
      type: 'Button',
      label: 'Row',
      hittable: true,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    },
    { index: 1, type: 'Button', label: 'Row', rect: { x: 0, y: 20, width: 50, height: 50 } },
    { index: 2, type: 'Button', label: 'Row' },
  ]);
  const visible = listSelectorChainMatches(visibleNodes, parseSelectorChain('visible=true'), {
    platform: 'ios',
  });
  assert.deepEqual(
    visible?.matchedNodes.map((node) => node.ref),
    ['e1', 'e2'],
  );
  const hidden = listSelectorChainMatches(visibleNodes, parseSelectorChain('hidden=true'), {
    platform: 'ios',
  });
  assert.deepEqual(
    hidden?.matchedNodes.map((node) => node.ref),
    ['e3'],
  );
});
