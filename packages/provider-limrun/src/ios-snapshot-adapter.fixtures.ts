import type { LimrunIosSession } from './ios.ts';
import type { AxeTreeNode } from '@agent-device/capture-kit/ios-axe-tree';

export const LIMRUN_SNAPSHOT_SCREEN: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 320,
  height: 240,
});

export function limrunSnapshotTree(): AxeTreeNode {
  return {
    elementType: 'Application',
    label: 'App',
    frame: {
      x: 0,
      y: 0,
      width: LIMRUN_SNAPSHOT_SCREEN.width,
      height: LIMRUN_SNAPSHOT_SCREEN.height,
    },
    children: [
      {
        elementType: 'Table',
        label: 'Settings',
        frame: {
          x: 0,
          y: 0,
          width: LIMRUN_SNAPSHOT_SCREEN.width,
          height: LIMRUN_SNAPSHOT_SCREEN.height,
        },
        children: [
          {
            elementType: 'Cell',
            label: 'Target',
            frame: { x: 16, y: 40, width: 288, height: 52 },
            children: [
              {
                elementType: 'Button',
                label: 'Save',
                frame: { x: 32, y: 48, width: 100, height: 36 },
                enabled: true,
                hittable: true,
              },
              {
                elementType: 'StaticText',
                label: 'Save',
                frame: { x: 32, y: 48, width: 100, height: 36 },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function createLimrunSnapshotSession(
  tree: AxeTreeNode | AxeTreeNode[] = limrunSnapshotTree(),
  screen = LIMRUN_SNAPSHOT_SCREEN,
): Pick<LimrunIosSession, 'client' | 'instanceId'> {
  return {
    instanceId: 'limrun-snapshot-test-instance',
    client: {
      elementTree: async () => tree,
      deviceInfo: { screenWidth: screen.width, screenHeight: screen.height },
    },
  } as unknown as Pick<LimrunIosSession, 'client' | 'instanceId'>;
}

type Point = { x: number; y: number };
type Screen = { width: number; height: number };
type Frame = NonNullable<AxeTreeNode['frame']>;

export const IPHONE_SCREEN: Readonly<Screen> = Object.freeze({ width: 402, height: 874 });
export const IPHONE_TAB_BAR_FRAME: Readonly<Frame> = Object.freeze({
  x: 0,
  y: 791,
  width: 402,
  height: 83,
});

/** An app screen whose root holds `children` above one line of text. */
export function limrunScreenTree(
  children: AxeTreeNode[],
  screen: Screen = IPHONE_SCREEN,
): AxeTreeNode[] {
  return [
    {
      type: 'Application',
      AXLabel: 'Agent Device Tester',
      frame: { x: 0, y: 0, ...screen },
      children: [
        {
          type: 'StaticText',
          AXLabel: 'Welcome',
          frame: { x: 16, y: 120, width: 300, height: 30 },
        },
        ...children,
      ],
    },
  ];
}

/** A childless `Group`, the way a live Limrun iPhone reports the iOS 26 tab bar. */
export function limrunEmptyGroup(frame: Frame, label?: string): AxeTreeNode {
  return {
    type: 'Group',
    ...(label ? { AXLabel: label } : {}),
    role: 'AXGroup',
    traits: ['Scrollable'],
    frame,
  };
}

export function limrunCollapsedTabBarTree(barFrame: Frame = IPHONE_TAB_BAR_FRAME): AxeTreeNode[] {
  return limrunScreenTree([limrunEmptyGroup(barFrame, 'Tab Bar')]);
}

/**
 * The five tab buttons a live Limrun iPhone 16 Pro (iOS 26.4) returned from `elementTree(point)`
 * inside the test app's tab bar, with Home selected.
 */
export const LIMRUN_TAB_BUTTONS: readonly AxeTreeNode[] = [
  limrunTabButton('Home', { x: 25, y: 795, width: 74, height: 54 }, true),
  limrunTabButton('Catalog', {
    x: 93.41666666666666,
    y: 795,
    width: 74.33333333333334,
    height: 54,
  }),
  limrunTabButton('Form', { x: 162.16666666666666, y: 795, width: 74, height: 54 }),
  limrunTabButton('Audio', { x: 230.58333333333331, y: 795, width: 74, height: 54 }),
  limrunTabButton('Settings', { x: 299, y: 795, width: 78, height: 54 }),
];

export function limrunTabButton(label: string, frame: Frame, selected = false): AxeTreeNode {
  return {
    type: 'RadioButton',
    role: 'AXRadioButton',
    subrole: 'AXTabButton',
    role_description: 'tab',
    AXLabel: label,
    AXValue: selected ? 1 : 0,
    traits: selected ? ['Selected', 'Button', 'TabButton'] : ['Button', 'TabButton'],
    enabled: true,
    frame,
    children: [],
  };
}

/**
 * A Limrun session whose `elementTree()` returns `tree` and whose `elementTree(point)` hit-tests
 * `hits`: the first whose frame holds the point, else the deepest tree node that does, as one node.
 * `hitTest` replaces that answer for a point, for example with a rejection.
 */
export function createLimrunHitTestSession(
  tree: AxeTreeNode[],
  hits: readonly AxeTreeNode[],
  options: {
    screen?: Screen;
    hitTest?: (point: Point, hit: AxeTreeNode) => Promise<AxeTreeNode | AxeTreeNode[]>;
  } = {},
) {
  const probes: Point[] = [];
  const deepestHit = (nodes: readonly AxeTreeNode[], point: Point) => {
    let hit: AxeTreeNode | undefined;
    for (const node of nodes) {
      if (!frameHolds(node.frame, point)) continue;
      hit = deepestHit(node.children ?? [], point) ?? node;
    }
    return hit;
  };
  const session = createLimrunSnapshotSession(tree, options.screen ?? IPHONE_SCREEN);
  session.client.elementTree = (async (point?: Point) => {
    if (!point) return tree;
    probes.push(point);
    const found = hits.find((node) => frameHolds(node.frame, point)) ?? deepestHit(tree, point);
    const hit = { ...found, children: [] };
    return options.hitTest ? options.hitTest(point, hit) : hit;
  }) as unknown as typeof session.client.elementTree;
  return { session, probes };
}

function frameHolds(frame: AxeTreeNode['frame'], point: Point): boolean {
  return (
    frame?.x !== undefined &&
    frame.y !== undefined &&
    frame.width !== undefined &&
    frame.height !== undefined &&
    point.x >= frame.x &&
    point.x < frame.x + frame.width &&
    point.y >= frame.y &&
    point.y < frame.y + frame.height
  );
}
