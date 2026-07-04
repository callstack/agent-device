import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { SnapshotState } from '../../kernel/snapshot.ts';
import {
  findSelectorChainMatch,
  parseSelectorChain,
  resolveSelectorChain,
  splitIsSelectorArgs,
  splitSelectorFromArgs,
} from '../selectors.ts';

const nodes: SnapshotState['nodes'] = [
  {
    ref: 'e1',
    index: 0,
    type: 'XCUIElementTypeTextField',
    label: 'Email',
    value: '',
    identifier: 'login_email',
    rect: { x: 0, y: 0, width: 200, height: 44 },
    enabled: true,
    hittable: true,
  },
  {
    ref: 'e2',
    index: 1,
    type: 'XCUIElementTypeButton',
    label: 'Continue',
    identifier: 'auth_continue',
    rect: { x: 0, y: 80, width: 200, height: 44 },
    enabled: true,
    hittable: true,
  },
  {
    ref: 'e3',
    index: 2,
    type: 'XCUIElementTypeButton',
    label: 'Continue',
    identifier: 'secondary_continue',
    rect: { x: 0, y: 140, width: 200, height: 44 },
    enabled: true,
    hittable: true,
  },
];

test('parseSelectorChain parses fallback and boolean terms', () => {
  const chain = parseSelectorChain('id=auth_continue || role=button label="Continue" visible=true');
  assert.equal(chain.selectors.length, 2);
  assert.equal(chain.selectors[0]!.terms[0]!.key, 'id');
  assert.equal(chain.selectors[1]!.terms[2]!.key, 'visible');
});

test('resolveSelectorChain resolves unique match', () => {
  const chain = parseSelectorChain('id=login_email');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e1');
});

test('resolveSelectorChain falls back when first selector is ambiguous', () => {
  const chain = parseSelectorChain('label="Continue" || id=auth_continue');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.selectorIndex, 1);
  assert.equal(resolved.node.ref, 'e2');
});

test('resolveSelectorChain keeps strict ambiguity behavior by default', () => {
  const chain = parseSelectorChain('label="Continue"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
  });
  assert.equal(resolved, null);
});

test('resolveSelectorChain disambiguates to deeper/smaller matching node when enabled', () => {
  const disambiguationNodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Other',
      label: 'Press me',
      rect: { x: 0, y: 0, width: 300, height: 300 },
      depth: 1,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      type: 'Other',
      label: 'Press me',
      rect: { x: 10, y: 10, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('role="other" label="Press me" || label="Press me"');
  const resolved = resolveSelectorChain(disambiguationNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e2');
  assert.equal(resolved.matches, 2);
});

test('resolveSelectorChain disambiguation prefers on-screen candidates over off-screen ones', () => {
  // Bluesky-style closed drawer: the drawer's "Profile" sits fully off-screen
  // left (deeper + smaller, so pre-viewport ranking picked it) while the bottom
  // tab "Profile" is visible. The visible candidate must win.
  const nodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      depth: 0,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: 20, y: 740, width: 200, height: 50 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: -320, y: 240, width: 100, height: 20 },
      depth: 3,
      enabled: true,
      hittable: false,
    },
  ];
  const chain = parseSelectorChain('label="Profile"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e2');
  assert.equal(resolved.matches, 2);
});

test('resolveSelectorChain disambiguation treats items inside an off-screen scroll container as off-screen', () => {
  // The closed drawer carries its own ScrollView at negative x. Visibility
  // relative to that (off-screen) container is not enough — the drawer item
  // must lose to the on-screen candidate.
  const nodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      depth: 0,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      rect: { x: -320, y: 0, width: 320, height: 800 },
      depth: 1,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Profile',
      rect: { x: -310, y: 240, width: 100, height: 20 },
      depth: 3,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 0,
      type: 'Button',
      label: 'Profile',
      rect: { x: 20, y: 740, width: 200, height: 50 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('label="Profile"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e4');
});

test('resolveSelectorChain disambiguation treats an edge-grazing off-screen container as off-screen', () => {
  // Bluesky regression: the closed drawer's overlay container pokes a fraction
  // of a pixel into the viewport (float rounding), but its center — the tap
  // point — is far off-screen. Edge overlap must not count as on-screen, so
  // with no other candidates the deeper drawer button still wins (and the
  // interaction guard then refuses it).
  const nodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
      depth: 0,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Explore',
      rect: { x: -321.6, y: 0, width: 321.67, height: 874 },
      depth: 1,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Explore',
      rect: { x: -321.6, y: 240, width: 321.33, height: 50 },
      depth: 3,
      enabled: true,
      hittable: false,
    },
  ];
  const chain = parseSelectorChain('label="Explore"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  // Neither candidate counts as on-screen, so the deepest-smallest tiebreak
  // applies — NOT a preference for the edge-grazing container.
  assert.equal(resolved.node.ref, 'e3');
});

test('resolveSelectorChain disambiguation keeps deepest-smallest when all candidates are off-screen', () => {
  const nodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
      depth: 0,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Drawer item',
      rect: { x: -320, y: 200, width: 300, height: 300 },
      depth: 2,
      enabled: true,
      hittable: false,
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Drawer item',
      rect: { x: -310, y: 240, width: 100, height: 20 },
      depth: 3,
      enabled: true,
      hittable: false,
    },
  ];
  const chain = parseSelectorChain('label="Drawer item"');
  const resolved = resolveSelectorChain(nodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.node.ref, 'e3');
});

test('resolveSelectorChain disambiguation tie falls back to next selector', () => {
  const tieNodes: SnapshotState['nodes'] = [
    {
      ref: 'e1',
      index: 0,
      type: 'Other',
      label: 'Press me',
      rect: { x: 0, y: 0, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e2',
      index: 1,
      type: 'Other',
      label: 'Press me',
      rect: { x: 0, y: 40, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
    {
      ref: 'e3',
      index: 2,
      type: 'Other',
      label: 'Press me',
      identifier: 'press_me_unique',
      rect: { x: 0, y: 80, width: 100, height: 20 },
      depth: 2,
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('label="Press me" || id="press_me_unique"');
  const resolved = resolveSelectorChain(tieNodes, chain, {
    platform: 'ios',
    requireRect: true,
    requireUnique: true,
    disambiguateAmbiguous: true,
  });
  assert.ok(resolved);
  assert.equal(resolved.selectorIndex, 1);
  assert.equal(resolved.node.ref, 'e3');
});

test('findSelectorChainMatch returns first matching selector for existence checks', () => {
  const chain = parseSelectorChain('label="Continue" || id=auth_continue');
  const match = findSelectorChainMatch(nodes, chain, {
    platform: 'ios',
  });
  assert.ok(match);
  assert.equal(match.selectorIndex, 0);
  assert.equal(match.matches, 2);
});

test('splitSelectorFromArgs extracts selector prefix and trailing value', () => {
  const split = splitSelectorFromArgs(['id=login_email', 'editable=true', 'qa@example.com']);
  assert.ok(split);
  assert.equal(split.selectorExpression, 'id=login_email editable=true');
  assert.deepEqual(split.rest, ['qa@example.com']);
});

test('splitSelectorFromArgs prefers trailing token for value when requested', () => {
  const split = splitSelectorFromArgs(['label="Filter"', 'visible=true'], {
    preferTrailingValue: true,
  });
  assert.ok(split);
  assert.equal(split.selectorExpression, 'label="Filter"');
  assert.deepEqual(split.rest, ['visible=true']);
});

test('splitSelectorFromArgs keeps full selector when trailing value preference is disabled', () => {
  const split = splitSelectorFromArgs(['label="Filter"', 'visible=true']);
  assert.ok(split);
  assert.equal(split.selectorExpression, 'label="Filter" visible=true');
  assert.deepEqual(split.rest, []);
});

test('parseSelectorChain rejects unknown keys and malformed quotes', () => {
  assert.throws(() => parseSelectorChain('foo=bar'), /Unknown selector key/i);
  assert.throws(() => parseSelectorChain('label="unclosed'), /Unclosed quote/i);
  assert.throws(() => parseSelectorChain(''), /cannot be empty/i);
});

test('parseSelectorChain handles quoted values ending in escaped backslashes', () => {
  const chain = parseSelectorChain('label="path\\\\" || id=auth_continue');
  assert.equal(chain.selectors.length, 2);
  assert.equal(chain.selectors[0]!.terms[0]!.value, 'path\\');
});

test('parseSelectorChain decodes escaped selector string values', () => {
  const chain = parseSelectorChain(
    [
      'label="Switch\\nMy Community"',
      'value="A\\tB\\rC\\bD\\fE\\/F"',
      'id="item_\\u0031\\uD83D\\uDE00"',
      "text='It\\'s OK'",
    ].join(' '),
  );

  assert.equal(chain.selectors[0]!.terms[0]!.value, 'Switch\nMy Community');
  assert.equal(chain.selectors[0]!.terms[1]!.value, 'A\tB\rC\bD\fE/F');
  assert.equal(chain.selectors[0]!.terms[2]!.value, `item_1${String.fromCodePoint(0x1f600)}`);
  assert.equal(chain.selectors[0]!.terms[3]!.value, "It's OK");
});

test('parseSelectorChain preserves malformed and unknown selector string escapes', () => {
  const chain = parseSelectorChain('label="bad\\u12" value="keep\\q"');

  assert.equal(chain.selectors[0]!.terms[0]!.value, 'bad\\u12');
  assert.equal(chain.selectors[0]!.terms[1]!.value, 'keep\\q');
});

test('parseSelectorChain preserves literal escaped control sequences when double escaped', () => {
  const chain = parseSelectorChain('label="foo\\\\nbar"');

  assert.equal(chain.selectors[0]!.terms[0]!.value, 'foo\\nbar');
});

test('resolveSelectorChain matches newline labels decoded from replay selectors', () => {
  const newlineNodes: SnapshotState['nodes'] = [
    {
      ref: 'n1',
      index: 0,
      type: 'XCUIElementTypeButton',
      label: 'Switch\nMy Community',
      rect: { x: 0, y: 0, width: 120, height: 44 },
      enabled: true,
      hittable: true,
    },
  ];
  const chain = parseSelectorChain('label="Switch\\nMy Community"');
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
  const resolvedLabel = resolveSelectorChain(nodes, chainByLabel, {
    platform: 'ios',
    requireUnique: true,
  });
  const resolvedId = resolveSelectorChain(nodes, chainById, {
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

// ── appName / windowTitle selectors ──────────────────────────────────────

test('appName selector matches nodes with appName field', () => {
  const desktopNodes: SnapshotState['nodes'] = [
    {
      ref: 'd1',
      index: 0,
      type: 'Button',
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

test('splitIsSelectorArgs accepts both predicate-first and selector-first forms', () => {
  const predicateFirst = splitIsSelectorArgs(['visible', 'text=Zzznope']);
  assert.equal(predicateFirst.predicate, 'visible');
  assert.equal(predicateFirst.split?.selectorExpression, 'text=Zzznope');
  assert.deepEqual(predicateFirst.split?.rest, []);

  // The trailing bare predicate must not be swallowed into the selector as a
  // boolean term (`visible` is both a selector key and a predicate name).
  const selectorFirst = splitIsSelectorArgs(['text=Zzznope', 'visible']);
  assert.equal(selectorFirst.predicate, 'visible');
  assert.equal(selectorFirst.split?.selectorExpression, 'text=Zzznope');
  assert.deepEqual(selectorFirst.split?.rest, []);

  const selectorFirstText = splitIsSelectorArgs(['id=title', 'text', 'Welcome']);
  assert.equal(selectorFirstText.predicate, 'text');
  assert.equal(selectorFirstText.split?.selectorExpression, 'id=title');
  assert.deepEqual(selectorFirstText.split?.rest, ['Welcome']);
});
