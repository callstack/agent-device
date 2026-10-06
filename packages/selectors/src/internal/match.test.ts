// Per-key matching semantics: what each selector key compares a node against.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { parseSelectorChain } from './parse.ts';
import { findSelectorChainMatch, resolveSelectorChain } from './resolve.ts';
import { loginFormNodes } from './__tests__/login-form-nodes.ts';
import { formatRole } from '@agent-device/kernel/snapshot';

test('resolveSelectorChain matches newline labels decoded from replay selectors', () => {
  const newlineNodes: SnapshotState['nodes'] = [
    {
      ref: 'n1',
      index: 0,
      type: 'XCUIElementTypeButton',
      kind: formatRole('XCUIElementTypeButton'),
      label: 'Switch\nMy Community',
      rect: { x: 0, y: 0, width: 120, height: 44 },
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain(String.raw`label="Switch\nMy Community"`);
  const resolved = resolveSelectorChain(newlineNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });

  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'n1');
});

test('text selector matches extractNodeText semantics (first non-empty field)', () => {
  const chainByLabel = parseSelectorChain('text=Email');
  const chainById = parseSelectorChain('text=login_email');
  const resolvedLabel = resolveSelectorChain(loginFormNodes, chainByLabel, {
    platform: 'ios',
    requireUnique: true,
  });
  const resolvedId = resolveSelectorChain(loginFormNodes, chainById, {
    platform: 'ios',
    requireUnique: true,
  });
  assert.ok(resolvedLabel);
  assert.equal(resolvedLabel.node.ref, 'e1');
  assert.equal(resolvedId, null);
});

test('role selector normalization matches Android class names by leaf type', () => {
  const androidNodes: SnapshotState['nodes'] = [
    {
      ref: 'a1',
      index: 0,
      type: 'android.widget.Button',
      kind: formatRole('android.widget.Button'),
      label: 'Continue',
      identifier: 'auth_continue',
      rect: { x: 0, y: 0, width: 120, height: 44 },
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('role=button label="Continue"');
  const resolved = resolveSelectorChain(androidNodes, chain, {
    platform: 'android',
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'a1');
});

// ── #3021: `role=` shares `kind`'s vocabulary, with a legacy-alias window ──

// One tree covering the three vocabulary decisions at once: the coarse kind
// `kind` publishes, the legacy leaf still windowed for it, and a sibling
// vocabulary word that must match NOTHING here.
const ROLE_VOCABULARY_NODES: SnapshotState['nodes'] = [
  {
    ref: 'text1',
    index: 0,
    type: 'XCUIElementTypeStaticText',
    kind: formatRole('XCUIElementTypeStaticText'),
    label: 'Total',
    rect: { x: 0, y: 0, width: 120, height: 20 },
    hittable: true,
  },
  {
    ref: 'field1',
    index: 1,
    type: 'android.widget.EditText',
    kind: formatRole('android.widget.EditText'),
    label: 'Email',
    rect: { x: 0, y: 30, width: 120, height: 44 },
    hittable: true,
  },
  {
    ref: 'button1',
    index: 2,
    type: 'XCUIElementTypeButton',
    kind: formatRole('XCUIElementTypeButton'),
    label: 'Continue',
    rect: { x: 0, y: 90, width: 120, height: 44 },
    hittable: true,
  },
];

function resolveRole(role: string, platform: 'ios' | 'android' = 'ios') {
  const chain = parseSelectorChain(`role=${role}`);
  return resolveSelectorChain(ROLE_VOCABULARY_NODES, chain, {
    platform,
    requireRect: true,
    requireUnique: true,
  });
}

test('role= matches the coarse kind vocabulary: kind=text and kind=text-field resolve', () => {
  // The migration's forward direction: these DID NOT match before #3021,
  // because the matcher saw the raw leaf (`statictext`, `edittext`).
  assert.equal(resolveRole('text')?.node.ref, 'text1');
  assert.equal(resolveRole('text-field', 'android')?.node.ref, 'field1');
});

test('role= keeps matching legacy leaf spellings during the alias window', () => {
  // The compatibility direction: released scripts write these; they must keep
  // resolving to the same nodes they resolved to before #3021.
  assert.equal(resolveRole('statictext')?.node.ref, 'text1');
  assert.equal(resolveRole('edittext', 'android')?.node.ref, 'field1');
  assert.equal(resolveRole('button')?.node.ref, 'button1');
  // The window is the node's OWN old spelling: `textfield` was the old leaf of
  // the iOS `TextField` class, never of `EditText`, and must not widen onto it.
  assert.equal(resolveRole('textfield', 'android'), null);
});

test('role= refuses a sibling vocabulary word that matches no kind or windowed alias', () => {
  // Nearest-negatives inside the same vocabulary: `text-view` is one dash from
  // `text`, and `switch`/`searchfield` are vocabulary entries (a kind and a
  // leaf windowed under kind `search`) that no node here carries.
  assert.equal(resolveRole('text-view'), null);
  assert.equal(resolveRole('switch'), null);
  assert.equal(resolveRole('searchfield'), null);
});

test('role= does not widen a legacy leaf onto kind siblings that never carried it', () => {
  // The window is the node's OWN old spelling. `linearlayout` and
  // `framelayout` share the coarse kind `group`; matching the leaf may not
  // pull in the kind's other members, or every released `role=linearlayout`
  // script would silently start hitting FrameLayout rows.
  const layoutNodes: SnapshotState['nodes'] = [
    'android.widget.LinearLayout',
    'android.widget.FrameLayout',
  ].map((type, idx) => ({
    ref: `row${idx + 1}`,
    index: idx,
    type,
    kind: formatRole(type),
    rect: { x: 0, y: idx * 50, width: 300, height: 48 },
    hittable: true,
  }));
  const chain = parseSelectorChain('role=linearlayout');
  const resolved = resolveSelectorChain(layoutNodes, chain, {
    platform: 'android',
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'row1');
});

test('role= agrees with the published kind for every node it matches (#3021 parity)', () => {
  // The architecture pin: for every node in the tree, matching by that node's
  // own published `kind` must resolve to exactly that node. This is what makes
  // the selector/kind divergence that #3021 closes impossible to reintroduce
  // silently for any vocabulary entry.
  for (const node of ROLE_VOCABULARY_NODES) {
    assert.ok(node.kind, 'fixture nodes carry a published kind');
    const chain = parseSelectorChain(`role=${JSON.stringify(node.kind)}`);
    const resolved = resolveSelectorChain(ROLE_VOCABULARY_NODES, chain, {
      platform: 'ios',
      requireRect: true,
      requireUnique: false,
    });
    assert.ok(resolved, `role=${node.kind} resolved nothing`);
    assert.equal(resolved.node.ref, node.ref, `role=${node.kind} resolved the wrong node`);
  }
});

test('focused selector matches snapshot focus state', () => {
  const tvNodes: SnapshotState['nodes'] = [
    {
      ref: 'tv1',
      index: 0,
      type: 'android.widget.TextView',
      kind: formatRole('android.widget.TextView'),
      label: 'Search',
      focused: false,
    },
    {
      ref: 'tv2',
      index: 1,
      type: 'android.widget.Button',
      kind: formatRole('android.widget.Button'),
      label: 'Play',
      focused: true,
    },
  ];
  const chain = parseSelectorChain('focused=true');
  const resolved = resolveSelectorChain(tvNodes, chain, {
    platform: 'android',
    requireUnique: true,
  });

  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'tv2');
});

// ── appName / windowTitle selectors ──────────────────────────────────────

test('appName selector matches nodes with appName field', () => {
  const desktopNodes: SnapshotState['nodes'] = [
    {
      ref: 'd1',
      index: 0,
      type: 'Button',
      kind: formatRole('Button'),
      label: 'OK',
      appName: 'Calculator',
      windowTitle: 'Main Window',
      rect: { x: 0, y: 0, width: 80, height: 30 },
      hittable: true,
    },
    {
      ref: 'd2',
      index: 1,
      type: 'Button',
      kind: formatRole('Button'),
      label: 'OK',
      appName: 'TextEditor',
      windowTitle: 'Untitled',
      rect: { x: 0, y: 0, width: 80, height: 30 },
      hittable: true,
    },
  ];

  // Match by appName — should disambiguate two OK buttons
  const chain1 = parseSelectorChain('label=OK appname=Calculator');
  const match1 = findSelectorChainMatch(desktopNodes, chain1, { platform: 'linux' });
  assert.ok(match1);
  assert.equal(match1.matches, 1);

  // Match by windowTitle
  const chain2 = parseSelectorChain('windowtitle=Untitled');
  const match2 = findSelectorChainMatch(desktopNodes, chain2, { platform: 'linux' });
  assert.ok(match2);
  assert.equal(match2.matches, 1);

  // Case-insensitive key (appName vs appname) and value
  const chain3 = parseSelectorChain('appName=calculator');
  const match3 = findSelectorChainMatch(desktopNodes, chain3, { platform: 'linux' });
  assert.ok(match3);
  assert.equal(match3.matches, 1);
});
