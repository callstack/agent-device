import type { RawSnapshotNode, Rect, SnapshotState } from '@agent-device/kernel/snapshot';
import { makeSnapshotState } from '@agent-device/selectors/snapshot-geometry-fixtures';

export function elementSettingsSnapshot(offscreenRowYs: number[]): SnapshotState {
  return makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        label: 'Element',
        rect: { x: 0, y: 0, width: 402, height: 874 },
        hittable: false,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Table',
        rect: { x: 0, y: 152, width: 402, height: 660 },
        hittable: true,
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'Cell',
        label: 'Visible profile row',
        rect: { x: 0, y: 251, width: 402, height: 69 },
        hittable: true,
      },
      ...offscreenRowYs.map((y, offset) => ({
        index: offset + 3,
        depth: 2,
        parentIndex: 1,
        type: 'Cell',
        label: '0',
        rect: { x: 0, y, width: 402, height: 49 },
        hittable: false,
      })),
    ],
    {
      backend: 'xctest',
      snapshotQuality: { state: 'healthy', backend: 'tree' },
    },
  );
}

export const elementThreadsNoticeSnapshot = makeSnapshotState(
  [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Element',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Threads no longer experimental',
      rect: { x: 0, y: 400, width: 402, height: 474 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Got it',
      rect: { x: 16, y: 760, width: 370, height: 48 },
    },
  ],
  { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
);

export const elementTransientRoomSnapshot = makeSnapshotState(
  [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Element',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'TextField',
      label: 'Weekend Plans',
      enabled: false,
      rect: { x: 100, y: 67, width: 113, height: 22 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'action file',
      rect: { x: 176, y: 790, width: 38, height: 38 },
    },
  ],
  { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
);

export const elementSettledRoomSnapshot = makeSnapshotState(
  [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Element',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Weekend Plans',
      rect: { x: 81, y: 58, width: 224, height: 40 },
    },
    {
      index: 2,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Upload',
      rect: { x: 12, y: 792, width: 36, height: 36 },
    },
  ],
  { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
);

// Screen-replacement fixtures in the SHAPE a live iPhone 17 (iOS 27) session projects — an
// `Application` root, the screen's own content, and a tab bar whose buttons keep the same identities
// across tabs — kept compact on purpose: a live screen of this app reports 24-34 nodes and the same
// proportion here is 18 (`snapshot -i`, October 2026). What the tests need is the ratio, not the
// volume: each fixture is a BROAD replacement of its siblings — fewer than half the node identities
// survive — which is why the complete-viewport-projection arm alone treats an ordinary tab switch
// or push as a screen replacement (#3470).

const TAB_BAR_LABELS = ['Home', 'Catalog', 'Form', 'Settings'];

function iosScreenSnapshot(
  content: Array<{ type: string; label: string; rect: Rect }>,
): SnapshotState {
  const nodes: RawSnapshotNode[] = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Agent Device Tester',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    ...content.map((node, offset) => ({
      index: offset + 1,
      depth: 1,
      parentIndex: 0,
      ...node,
    })),
  ];
  const tabBarIndex = nodes.length;
  nodes.push({
    index: tabBarIndex,
    depth: 1,
    parentIndex: 0,
    type: 'TabBar',
    label: 'Tab Bar',
    rect: { x: 0, y: 791, width: 402, height: 83 },
  });
  TAB_BAR_LABELS.forEach((label, offset) => {
    nodes.push({
      index: nodes.length,
      depth: 2,
      parentIndex: tabBarIndex,
      type: 'Button',
      label,
      rect: { x: 12 + offset * 96, y: 795, width: 92, height: 54 },
    });
  });
  return makeSnapshotState(nodes, {
    backend: 'xctest',
    snapshotQuality: { state: 'healthy', backend: 'tree' },
  });
}

/** A tab's list screen: the shared tab bar plus that tab's own rows. */
export function elementCatalogTabSnapshot(): SnapshotState {
  return iosScreenSnapshot(
    Array.from({ length: 12 }, (_, offset) => ({
      type: 'Cell',
      label: `Catalog product ${offset + 1}`,
      rect: { x: 0, y: 120 + offset * 90, width: 402, height: 84 },
    })),
  );
}

/** The tab you switch to: different rows, same tab bar, same app root. */
export function elementSettingsTabSnapshot(): SnapshotState {
  return iosScreenSnapshot(
    Array.from({ length: 12 }, (_, offset) => ({
      type: 'Button',
      label: `Open settings fixture ${offset + 1}`,
      rect: { x: 16, y: 120 + offset * 60, width: 370, height: 45 },
    })),
  );
}

/** The screen a push opens: its own nav bar and content, and the tab bar's row is gone. */
export function elementPushedDetailSnapshot(): SnapshotState {
  return makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Application',
        label: 'Agent Device Tester',
        rect: { x: 0, y: 0, width: 402, height: 874 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'NavigationBar',
        label: 'Automation',
        rect: { x: 0, y: 62, width: 402, height: 54 },
      },
      {
        index: 2,
        depth: 2,
        parentIndex: 1,
        type: 'Button',
        label: '(tabs)',
        rect: { x: 16, y: 62, width: 44, height: 44 },
      },
      ...['Open automation sheet', 'Press canary', 'Long press canary'].map((label, offset) => ({
        index: 3 + offset,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label,
        rect: { x: 16, y: 240 + offset * 120, width: 370, height: 45 },
      })),
    ],
    { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
  );
}

/**
 * A system permission prompt's own projection: the runner roots it at an `Alert` node and the app
 * content it presents over is not in the tree (#2660). Larger than `TINY_STABLE_TREE_NODE_COUNT`, so
 * its size alone does not mark it as presented.
 */
export function systemPermissionPromptSnapshot(): SnapshotState {
  return makeSnapshotState(
    [
      {
        index: 0,
        depth: 0,
        type: 'Alert',
        label: 'Allow “Agent Device Tester” to access your microphone?',
        rect: { x: 40, y: 309, width: 322, height: 283 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'StaticText',
        label: 'Allow Agent Device Tester to exercise microphone permissions.',
        rect: { x: 60, y: 420, width: 282, height: 42 },
      },
      {
        index: 2,
        depth: 1,
        parentIndex: 0,
        type: 'StaticText',
        label: 'Microphone access lets the lab record a clip.',
        rect: { x: 60, y: 470, width: 282, height: 38 },
      },
      {
        index: 3,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Don’t Allow',
        rect: { x: 60, y: 528, width: 130, height: 48 },
      },
      {
        index: 4,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Allow',
        rect: { x: 212, y: 528, width: 130, height: 48 },
      },
      {
        index: 5,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Learn More',
        rect: { x: 136, y: 580, width: 130, height: 48 },
      },
    ],
    { backend: 'xctest', snapshotQuality: { state: 'healthy', backend: 'tree' } },
  );
}
