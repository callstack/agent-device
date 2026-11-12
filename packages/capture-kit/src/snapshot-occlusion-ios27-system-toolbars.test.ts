import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { presentIosSnapshot } from './ios-snapshot-engine/engine.ts';
import { annotateCoveredSnapshotNodes } from './snapshot-occlusion.ts';

// Captured on an iPhone 18 Pro simulator, iOS 27.0. `contactsNewContactInteractive` is the input the
// occlusion pass received for `snapshot -i` on Contacts > New Contact after typing a first name.
// `settingsGeneralRaw` is `snapshot --raw` on Settings > General, which the iOS engine projects,
// cut to the navigation bar, the first two rows, the toolbars, and their ancestors.
type Captures = {
  contactsNewContactInteractive: RawSnapshotNode[];
  settingsGeneralRaw: RawSnapshotNode[];
};

function captures(): Captures {
  return JSON.parse(
    readFileSync(
      new URL('./snapshot-occlusion-ios27-system-toolbars.fixture.json', import.meta.url),
      'utf8',
    ),
  ) as Captures;
}

function coveredLabels(nodes: RawSnapshotNode[]): string[] {
  return annotateCoveredSnapshotNodes(nodes)
    .filter((candidate) => candidate.interactionBlocked === 'covered')
    .map((candidate) => candidate.label ?? candidate.type ?? '');
}

function nodeWithLabel(nodes: RawSnapshotNode[], label: string): RawSnapshotNode {
  const node = nodes.find((candidate) => candidate.label === label);
  assert.ok(node, label);
  return node;
}

test('the captured Contacts sheet keeps Done and its rows pressable under its own toolbars', () => {
  // The sheet's floating bar container encloses the sheet's navigation bar and table. The bar-height
  // passthrough toolbar listed before it encloses nothing, so it is not a presentation boundary, and
  // it is drawn inside the navigation bar, so it backs Done instead of covering it.
  assert.deepEqual(coveredLabels(captures().contactsNewContactInteractive), []);
});

test('a toolbar that extends past the navigation bar still covers Done', () => {
  const nodes = captures().contactsNewContactInteractive;
  const passthrough = nodes.find((candidate) => candidate.role === 'CNPassthroughToolbar');
  assert.ok(passthrough, 'CNPassthroughToolbar');
  passthrough.rect = { x: 0, y: 83, width: 402, height: 120 };

  assert.ok(coveredLabels(nodes).includes('Done'));
});

test('a menu inside the navigation bar still covers Done', () => {
  const nodes = captures().contactsNewContactInteractive;
  nodes.push({
    index: nodes.length,
    parentIndex: 0,
    depth: 1,
    type: 'Menu',
    label: 'More',
    rect: { x: 300, y: 80, width: 100, height: 50 },
    hittable: true,
  });

  assert.ok(coveredLabels(nodes).includes('Done'));
});

test('a bottom toolbar of the screen beneath an undimmed sheet keeps that screen covered', () => {
  const screen = { x: 0, y: 0, width: 402, height: 874 };
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application', label: 'App', rect: screen },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'ScrollView',
      rect: { x: 0, y: 0, width: 402, height: 791 },
    },
    {
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Button',
      label: 'Lower row',
      rect: { x: 16, y: 600, width: 370, height: 52 },
    },
    {
      index: 3,
      parentIndex: 0,
      depth: 1,
      type: 'Toolbar',
      role: 'UIToolbar',
      rect: { x: 0, y: 791, width: 402, height: 49 },
    },
    {
      index: 4,
      parentIndex: 3,
      depth: 2,
      type: 'Button',
      label: 'Compose',
      rect: { x: 340, y: 796, width: 44, height: 40 },
    },
    {
      index: 5,
      parentIndex: 0,
      depth: 1,
      type: 'NavigationBar',
      label: 'Sheet',
      rect: { x: 0, y: 78, width: 402, height: 54 },
    },
    {
      index: 6,
      parentIndex: 0,
      depth: 1,
      type: 'ScrollView',
      rect: { x: 0, y: 132, width: 402, height: 400 },
    },
    {
      index: 7,
      parentIndex: 6,
      depth: 2,
      type: 'Button',
      label: 'Sheet row',
      rect: { x: 16, y: 140, width: 370, height: 52 },
    },
    {
      index: 8,
      parentIndex: 0,
      depth: 1,
      type: 'Toolbar',
      role: '_UIFloatingBarContainerView',
      label: 'Toolbar',
      rect: { x: 0, y: 62, width: 402, height: 812 },
    },
  ];

  const covered = coveredLabels(nodes);
  assert.ok(covered.includes('Lower row'));
  assert.ok(covered.includes('Compose'));
  assert.ok(!covered.includes('Sheet row'));
});

test('the captured Settings screen keeps its rows pressable under its full-screen toolbars', () => {
  // The app node shares the back button's label. The projection keeps it as the viewport root, so
  // the full-screen toolbar containers under it are exempt and do not cover the rows.
  const request = createIosSnapshotRequest({ interactiveOnly: true });
  const hint = deriveIosCaptureHint(request);
  const presented = presentIosSnapshot(
    {
      stage: 'acquired',
      acquisition: {
        producer: 'simulator-ax-bridge',
        intent: 'full',
        hint: { ...hint, acquisitionIntent: 'full' },
        nodes: captures().settingsGeneralRaw,
        truncated: false,
        viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 402, height: 874 } },
        lineage: { targetId: 'simulator-1', generation: 'generation-1' },
        residue: [],
      },
    },
    request,
  );

  nodeWithLabel(presented.nodes, 'About');
  assert.deepEqual(coveredLabels(presented.nodes), []);
  assert.equal(presented.nodes[0]?.label, 'Settings');
});
