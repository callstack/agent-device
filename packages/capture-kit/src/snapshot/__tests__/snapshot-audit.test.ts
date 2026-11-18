import { describe, expect, test } from 'vitest';
import type { AuditContext, AuditFinding } from '@agent-device/contracts/capture';
import type { RawSnapshotNode, SnapshotNode } from '@agent-device/kernel/snapshot';
import { annotateCoveredSnapshotNodes } from '../../snapshot-occlusion.ts';
import { auditSnapshot } from '../snapshot-audit.ts';

const IOS: AuditContext = { platform: 'ios', truncated: false };
const ANDROID: AuditContext = { platform: 'android', pixelDensity: 2, truncated: false };

function node(index: number, fields: Partial<SnapshotNode> = {}): SnapshotNode {
  return {
    index,
    ref: `e${index}`,
    type: 'Button',
    hittable: true,
    rect: { x: 0, y: index * 100, width: 100, height: 60 },
    ...fields,
  };
}

function audit(nodes: SnapshotNode[], context: AuditContext = IOS) {
  return auditSnapshot(nodes, context);
}

function summarize(findings: AuditFinding[]): string[] {
  return findings.map((finding) => `${finding.kind} ${finding.ref}`);
}

describe('small-target', () => {
  test('reports a control below 44pt on iOS with its size and the recommendation', () => {
    const { findings } = audit([
      node(1, { label: 'Menu', rect: { x: 0, y: 0, width: 30, height: 44 } }),
    ]);
    expect(findings).toEqual([
      expect.objectContaining({
        kind: 'small-target',
        severity: 'warning',
        ref: '@e1',
        detail: { unit: 'pt', width: 30, height: 44, recommendedSize: 44 },
      }),
    ]);
  });

  test('accepts a 44pt control that float layout reports as 43.67', () => {
    const { findings } = audit([
      node(1, { label: 'OK', rect: { x: 0, y: 0, width: 43.67, height: 44 } }),
    ]);
    expect(findings).toEqual([]);
  });

  test('divides Android pixels by the captured density before comparing with 48dp', () => {
    const small = { x: 0, y: 0, width: 80, height: 100 };
    expect(summarize(audit([node(1, { label: 'A', rect: small })], ANDROID).findings)).toEqual([
      'small-target @e1',
    ]);
    // 100px is 100dp at density 1, so the same rect passes there.
    expect(
      audit([node(1, { label: 'A', rect: small })], {
        platform: 'android',
        pixelDensity: 1,
        truncated: false,
      }).findings,
    ).toEqual([]);
  });

  test('skips the check and says why when Android density is unknown', () => {
    const result = audit([node(1, { label: 'A', rect: { x: 0, y: 0, width: 10, height: 10 } })], {
      platform: 'android',
      truncated: false,
    });
    expect(result.findings).toEqual([]);
    expect(result.limitations).toEqual([expect.stringContaining('did not report display density')]);
  });

  test('skips the check on a TV target', () => {
    const result = audit([node(1, { label: 'A', rect: { x: 0, y: 0, width: 10, height: 10 } })], {
      platform: 'ios',
      target: 'tv',
      truncated: false,
    });
    expect(result.findings).toEqual([]);
    expect(result.limitations).toEqual([expect.stringContaining('tv targets')]);
  });

  test('ignores a disabled control, an offscreen control, and a keyboard key', () => {
    const tiny = { x: 0, y: 0, width: 20, height: 20 };
    const { findings } = audit([
      node(1, { label: 'Off', enabled: false, rect: tiny }),
      node(2, { label: 'Away', hittable: false, rect: tiny }),
      node(3, { label: 'q', keyboardOwned: true, rect: tiny }),
    ]);
    expect(findings).toEqual([]);
  });

  test('ignores a link inside a text container, but not a link beside text or at the root', () => {
    const tiny = { x: 0, y: 0, width: 60, height: 18 };
    const inText = audit([
      node(0, { type: 'StaticText', label: 'Read the terms', hittable: false }),
      node(1, { parentIndex: 0, type: 'Link', label: 'terms', rect: tiny }),
    ]);
    expect(inText.findings).toEqual([]);

    const besideText = audit([
      node(0, { type: 'Other', hittable: false }),
      node(1, { parentIndex: 0, type: 'StaticText', label: 'Read the' }),
      node(2, { parentIndex: 0, type: 'Link', label: 'terms', rect: tiny }),
    ]);
    expect(summarize(besideText.findings)).toEqual(['small-target @e2']);

    const atRoot = audit([
      node(0, { type: 'StaticText', label: 'Title' }),
      node(1, { type: 'Link', label: 'terms', rect: tiny }),
    ]);
    expect(summarize(atRoot.findings)).toEqual(['small-target @e1']);
  });
});

describe('missing-name', () => {
  test('reports a button whose only text is an identifier or a value', () => {
    const { findings } = audit([
      node(1, { identifier: 'menu-button' }),
      node(2, { value: 'On' }),
      node(3, { label: 'com.example:id/menu' }),
    ]);
    expect(summarize(findings)).toEqual([
      'missing-name @e1',
      'missing-name @e2',
      'missing-name @e3',
    ]);
  });

  test('accepts a label, an Android content description, or a named descendant', () => {
    const { findings } = audit([
      node(1, { label: 'Save' }),
      node(5, { label: 'Dictate', identifier: 'Dictate' }),
      node(2, { contentDescription: 'Close' }),
      node(3),
      node(4, { parentIndex: 3, type: 'StaticText', label: 'Next' }),
    ]);
    expect(findings).toEqual([]);
  });

  test('does not treat typed field content as its name, but accepts a placeholder or hint label', () => {
    const { findings } = audit([
      node(1, { type: 'TextField', label: 'hello', value: 'hello' }),
      node(2, { type: 'TextField', value: 'hello', placeholder: 'Email' }),
      node(3, { type: 'SearchField', label: 'Search', value: 'Search', placeholder: 'Search' }),
    ]);
    expect(summarize(findings)).toEqual(['missing-name @e1']);
  });

  test('reports an unnamed image button but not a decorative image', () => {
    const { findings } = audit([
      node(1, { type: 'android.widget.ImageButton' }),
      node(2, { type: 'Image' }),
      node(3, { type: 'android.widget.ImageView' }),
    ]);
    expect(summarize(findings)).toEqual(['missing-name @e1']);
  });

  test('does not read a container class as a control', () => {
    const { findings } = audit([
      node(1, { type: 'android.widget.RadioGroup' }),
      node(2, { type: 'android.widget.TabLayout' }),
    ]);
    expect(findings).toEqual([]);
  });
});

describe('duplicate wrappers', () => {
  const small = { x: 0, y: 0, width: 20, height: 20 };

  test('collapses a control that is the only child of a same-role control that reports the same kinds', () => {
    const { findings } = audit([
      node(1, { rect: small }),
      node(2, { parentIndex: 1, rect: small }),
    ]);
    expect(summarize(findings)).toEqual(['small-target @e1', 'missing-name @e1']);
  });

  test('keeps the child when the parent has a sibling child or another role', () => {
    const withSibling = audit([
      node(1, { label: 'A', rect: small }),
      node(2, { parentIndex: 1, label: 'B', rect: small }),
      node(3, { parentIndex: 1, type: 'StaticText', label: 'x' }),
    ]);
    expect(summarize(withSibling.findings)).toEqual(['small-target @e1', 'small-target @e2']);

    const otherRole = audit([
      node(1, { label: 'A', rect: small }),
      node(2, { parentIndex: 1, type: 'Switch', label: 'B', rect: small }),
    ]);
    expect(summarize(otherRole.findings)).toEqual(['small-target @e1', 'small-target @e2']);
  });

  test('keeps the child when the parent does not report that kind', () => {
    const disabledParent = audit([
      node(1, { label: 'A', enabled: false, rect: small }),
      node(2, { parentIndex: 1, label: 'B', rect: small }),
    ]);
    expect(summarize(disabledParent.findings)).toEqual(['small-target @e2']);

    const largeParent = audit([
      node(1, { label: 'A', rect: { x: 0, y: 0, width: 100, height: 100 } }),
      node(2, { parentIndex: 1, label: 'B', rect: small }),
    ]);
    expect(summarize(largeParent.findings)).toEqual(['small-target @e2']);

    const refLessParent = audit([
      node(1, { ref: undefined, label: 'A', rect: small }),
      node(2, { parentIndex: 1, label: 'B', rect: small }),
    ]);
    expect(summarize(refLessParent.findings)).toEqual(['small-target @e2']);
  });

  test('does not collapse unrelated controls that share a rect', () => {
    const { findings } = audit([
      node(1, { label: 'A', rect: small }),
      node(2, { label: 'B', rect: small }),
    ]);
    expect(summarize(findings)).toEqual(['small-target @e1', 'small-target @e2']);
  });
});

describe('covered-control', () => {
  const covered = { interactionBlocked: 'covered', hittable: false } as const;

  test('reports a covered control as an observation', () => {
    const { findings } = audit([node(1, { label: 'Pay', ...covered })]);
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'covered-control', severity: 'observation', ref: '@e1' }),
    ]);
  });

  test('ignores covered images and text, which no touch targets', () => {
    const { findings } = audit([
      node(1, { type: 'Image', label: 'Overlay', ...covered }),
      node(2, { type: 'StaticText', label: 'Title', ...covered }),
    ]);
    expect(findings).toEqual([]);
  });

  test('collapses the only child of a covered row, but keeps a child that has siblings', () => {
    const wrapped = audit([
      node(1, { type: 'Cell', ...covered }),
      node(2, { parentIndex: 1, label: 'Passcode', ...covered }),
    ]);
    expect(summarize(wrapped.findings)).toEqual(['covered-control @e1']);

    const withSibling = audit([
      node(1, { type: 'Cell', ...covered }),
      node(2, { parentIndex: 1, label: 'Passcode', ...covered }),
      node(3, { parentIndex: 1, label: 'Info', ...covered }),
    ]);
    expect(summarize(withSibling.findings)).toEqual([
      'covered-control @e1',
      'covered-control @e2',
      'covered-control @e3',
    ]);
  });

  test('keeps a covered control under a covered container that is neither control nor row', () => {
    const { findings } = audit([
      node(1, { type: 'Other', ...covered }),
      node(2, { parentIndex: 1, label: 'Pay', ...covered }),
    ]);
    expect(summarize(findings)).toEqual(['covered-control @e2']);
  });

  test('keeps a covered child whose parent is not covered', () => {
    const { findings } = audit([
      node(1, { type: 'Cell' }),
      node(2, { parentIndex: 1, label: 'A', ...covered }),
    ]);
    expect(summarize(findings)).toEqual(['covered-control @e2']);
  });

  test('does not run the other checks on a covered control', () => {
    const { findings } = audit([
      node(1, { ...covered, rect: { x: 0, y: 0, width: 10, height: 10 } }),
    ]);
    expect(summarize(findings)).toEqual(['covered-control @e1']);
  });
});

describe('scope', () => {
  test('skips system bars and nodes without a ref', () => {
    const { findings } = audit([node(1, { systemBar: 'navigation' }), node(2, { ref: undefined })]);
    expect(findings).toEqual([]);
  });

  test('marks a truncated capture partial and says controls past the cut were not audited', () => {
    const result = audit([node(1, { label: 'A' })], { ...IOS, truncated: true });
    expect(result.checks).toEqual({ snapshot: 'partial' });
    expect(result.limitations).toEqual([expect.stringContaining('truncated')]);
  });

  test('audits a web radio as a control and keeps its radiogroup container out', () => {
    const result = audit(
      [node(1, { type: 'radiogroup' }), node(2, { type: 'radio', parentIndex: 1 })],
      { platform: 'web', truncated: false },
    );
    expect(summarize(result.findings)).toEqual(['missing-name @e2']);
  });

  test('keeps unknown truncation unknown instead of calling the capture complete', () => {
    const result = audit([node(1, { label: 'A' })], { platform: 'ios' });
    expect(result.checks).toEqual({ snapshot: 'unknown' });
    expect(result.limitations).toEqual([expect.stringContaining('cannot report truncation')]);
  });

  test('audits web ARIA roles for names and coverage but not size', () => {
    const result = audit(
      [
        node(1, { type: 'button' }),
        node(2, { type: 'textbox', label: 'Email' }),
        node(3, { type: 'link', label: 'Home', interactionBlocked: 'covered', hittable: false }),
      ],
      { platform: 'web', truncated: false },
    );
    expect(summarize(result.findings)).toEqual(['missing-name @e1', 'covered-control @e3']);
    expect(result.limitations).toEqual([expect.stringContaining('web rects')]);
  });
});

test('publishes the captured label and identifier but omits a missing-name label', () => {
  const findings = audit([
    node(1, { label: 'Save Lemon Herb Rice', rect: { x: 0, y: 0, width: 22, height: 22 } }),
    node(2, { identifier: 'save', label: 'com.example:id/save' }),
    node(3, { label: 'Pay', interactionBlocked: 'covered', hittable: false }),
  ]).findings;
  expect(findings[0]).toMatchObject({ label: 'Save Lemon Herb Rice' });
  expect(findings[1]).toMatchObject({ kind: 'missing-name', identifier: 'save' });
  expect(findings[1]).not.toHaveProperty('label');
  expect(findings[2]).toMatchObject({ label: 'Pay' });
});

type CoverPublication = {
  name: string;
  type: string;
  role?: string;
  subrole?: string;
  label?: string;
};

/**
 * Window > screen holding a scroll view (one row inside) and a fixed control, with the cover listed
 * last so it draws on top. The row and the fixed control both sit under the cover. The occlusion scan
 * produces each `coveredBy`, so the audit reads exactly what a capture publishes.
 */
function scannedCoverTree(cover: CoverPublication): SnapshotNode[] {
  const raw: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Window', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Other',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'ScrollView',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: 'Button',
      label: 'Scrolled row',
      hittable: true,
      rect: { x: 0, y: 800, width: 402, height: 60 },
    },
    {
      index: 4,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      label: 'Fixed control',
      hittable: true,
      rect: { x: 300, y: 800, width: 60, height: 60 },
    },
    {
      index: 5,
      parentIndex: 1,
      depth: 2,
      type: cover.type,
      ...(cover.role ? { role: cover.role } : {}),
      ...(cover.subrole ? { subrole: cover.subrole } : {}),
      ...(cover.label ? { label: cover.label } : {}),
      hittable: true,
      rect: { x: 0, y: 791, width: 402, height: 83 },
    },
  ];
  return annotateCoveredSnapshotNodes(raw).map((scanned) => ({
    ...scanned,
    ref: `e${scanned.index}`,
  }));
}

test.for<CoverPublication>([
  { name: 'type only', type: 'TabBar' },
  { name: 'navigation bar type', type: 'NavigationBar', label: 'Inbox' },
  { name: 'toolbar type', type: 'Toolbar' },
  { name: 'UIKit class in role beside a generic type', type: 'Other', role: 'UITabBar' },
  { name: 'subrole only', type: 'Other', subrole: 'AXToolbar' },
  {
    name: 'Android bottom navigation',
    type: 'com.google.android.material.bottomnavigation.BottomNavigationView',
  },
])('ignores a scanned bar from the $name publication over a scrolled row only', (cover) => {
  const nodes = scannedCoverTree(cover);
  expect(nodes[3]).toMatchObject({
    interactionBlocked: 'covered',
    coveredBy: { persistentBar: true, targetInScrollableContent: true },
  });
  expect(nodes[4]?.coveredBy).toMatchObject({ persistentBar: true });
  expect(nodes[4]?.coveredBy?.targetInScrollableContent).toBeUndefined();
  expect(summarize(audit(nodes).findings)).toEqual(['covered-control @e4']);
});

test.for<CoverPublication>([
  { name: 'sheet', type: 'Sheet' },
  { name: 'dialog', type: 'Dialog', label: 'Tab Bar' },
  { name: 'labelled alert group', type: 'Alert', label: 'Confirm' },
])('retains a scanned $name over a control inside a scroll container', (cover) => {
  const nodes = scannedCoverTree(cover);
  expect(nodes[3]).toMatchObject({ interactionBlocked: 'covered' });
  expect(nodes[3]?.coveredBy?.persistentBar).toBeUndefined();
  expect(summarize(audit(nodes).findings)).toEqual(['covered-control @e3', 'covered-control @e4']);
});

test.each([
  [IOS, 'Apple HIG recommends 44×44pt.'],
  [ANDROID, 'Material recommends 48×48dp.'],
] as const)('returns guidance only for present kinds on %j', (context, size) => {
  const result = audit(
    [
      node(1, { label: 'Save', rect: { x: 0, y: 0, width: 22, height: 22 } }),
      node(2, { label: 'Save again', rect: { x: 0, y: 0, width: 22, height: 22 } }),
      node(3),
      node(4, { interactionBlocked: 'covered', hittable: false }),
    ],
    context,
  );
  expect(result.guidance).toEqual({
    'small-target': `${size} Enlarge the touch area with padding, a minimum size, or hitSlop.`,
    'missing-name':
      'Set an accessibility label (iOS accessibilityLabel, Android contentDescription, React Native accessibilityLabel).',
    'covered-control':
      'Move the control out from under the cover. If the cover can be dismissed, such as a sheet or dialog, dismiss it before you use the control.',
  });
  expect(
    audit([node(1, { label: 'Large', rect: { x: 0, y: 0, width: 100, height: 100 } })], context)
      .guidance,
  ).toEqual({});
  expect(
    Object.keys(
      audit([node(1, { rect: { x: 0, y: 0, width: 100, height: 100 } })], context).guidance,
    ),
  ).toEqual(['missing-name']);
});

test('keeps a child under an overlay when its covered row is excluded as scroll chrome', () => {
  const findings = audit([
    node(0, { type: 'ScrollView', hittable: false }),
    node(1, {
      type: 'Cell',
      parentIndex: 0,
      interactionBlocked: 'covered',
      coveredBy: { kind: 'tab-bar', persistentBar: true, targetInScrollableContent: true },
    }),
    node(2, {
      parentIndex: 1,
      label: 'Pay',
      interactionBlocked: 'covered',
      coveredBy: { kind: 'sheet' },
    }),
  ]).findings;
  expect(summarize(findings)).toEqual(['covered-control @e2']);
});

test('skips UIKit sheet grabbers by captured class without matching their label', () => {
  const small = { x: 0, y: 0, width: 73, height: 24 };
  const findings = audit([
    node(1, { role: '_UIGrabber', label: 'Sheet Grabber', value: 'Expanded', rect: small }),
    node(2, { role: '_UIGrabber', label: 'Poignée', rect: small }),
    node(3, { subrole: '_UIGrabber', rect: small }),
    node(4, { label: 'Sheet Grabber', rect: small }),
  ]).findings;
  expect(summarize(findings)).toEqual(['small-target @e4']);
});

test.each(['NavigationBar', 'Toolbar', 'TabBar'])(
  'skips iOS %s target size but keeps missing names and app content',
  (type) => {
    const small = { x: 0, y: 0, width: 42.2, height: 42.2 };
    const nodes = [
      node(0, { type, hittable: false }),
      node(2, { parentIndex: 0, label: 'Cancel', rect: { ...small, width: 50.6 } }),
      node(3, { parentIndex: 0, label: 'Add', rect: small }),
      node(4, { parentIndex: 0, identifier: 'unnamed-bar-item', rect: small }),
      node(5, { label: 'App action', rect: small }),
    ];
    expect(summarize(audit(nodes).findings)).toEqual(['missing-name @e4', 'small-target @e5']);
    expect(summarize(audit(nodes, ANDROID).findings)).toEqual([
      'small-target @e2',
      'small-target @e3',
      'small-target @e4',
      'missing-name @e4',
      'small-target @e5',
    ]);
  },
);

test.each(['NavigationBar', 'Toolbar', 'TabBar', 'BottomNavigationView'])(
  'checks app content inside a %s-shaped container',
  (type) => {
    for (const container of ['ScrollView', 'Other', 'Button']) {
      const result = audit([
        node(0, { type, hittable: false }),
        node(1, { type: container, label: 'Content', parentIndex: 0 }),
        node(2, { label: 'Save', parentIndex: 1, rect: { x: 0, y: 0, width: 22, height: 22 } }),
      ]);
      expect(summarize(result.findings), container).toEqual(['small-target @e2']);
    }
  },
);

test.each([{ type: 'HomeToolbarView' }, { type: 'Other', role: 'BottomTabBar' }])(
  'checks the size of controls in the custom iOS bar %j',
  (container) => {
    const result = audit([
      node(0, { ...container, hittable: false }),
      node(1, {
        parentIndex: 0,
        label: 'Save',
        rect: { x: 0, y: 0, width: 24, height: 24 },
      }),
    ]);
    expect(summarize(result.findings)).toEqual(['small-target @e1']);
  },
);

test.each([{ role: 'UITabBar' }, { subrole: 'UIToolbar' }, { subrole: 'AXToolbar' }])(
  'recognizes a direct bar item through its parent class %j',
  (barClass) => {
    const item = node(1, {
      parentIndex: 0,
      label: 'Save',
      rect: { x: 0, y: 0, width: 36, height: 36 },
    });
    const parent = node(0, { type: 'Other', hittable: false, ...barClass });
    expect(audit([parent, item]).findings).toEqual([]);
    expect(summarize(audit([parent, { ...item, label: undefined }]).findings)).toEqual([
      'missing-name @e1',
    ]);
    expect(
      summarize(audit([{ ...parent, role: 'UIView', subrole: undefined }, item]).findings),
    ).toEqual(['small-target @e1']);
  },
);
