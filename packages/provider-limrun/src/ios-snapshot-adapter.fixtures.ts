import type { LimrunIosSession } from './ios.ts';
import type { IosTreeNode } from './snapshot.ts';

export const LIMRUN_SNAPSHOT_SCREEN: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 320,
  height: 240,
});

export function limrunSnapshotTree(): IosTreeNode {
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
  tree: IosTreeNode | IosTreeNode[] = limrunSnapshotTree(),
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

const IPHONE_SCREEN = { width: 402, height: 874 };
const IPHONE_TAB_BAR_FRAME = { x: 0, y: 791, width: 402, height: 83 };

/** The iOS 26 tab bar as a live Limrun iPhone reports it: one childless `Group` along the bottom. */
export function limrunCollapsedTabBarTree(
  barFrame: IosTreeNode['frame'] = IPHONE_TAB_BAR_FRAME,
): IosTreeNode[] {
  return [
    {
      type: 'Application',
      AXLabel: 'Agent Device Tester',
      frame: { x: 0, y: 0, ...IPHONE_SCREEN },
      children: [
        {
          type: 'StaticText',
          AXLabel: 'Welcome',
          frame: { x: 16, y: 120, width: 370, height: 30 },
        },
        {
          type: 'Group',
          AXLabel: 'Tab Bar',
          role: 'AXGroup',
          traits: ['Scrollable'],
          frame: barFrame,
        },
      ],
    },
  ];
}

/** The tab buttons a live Limrun `elementTree(point)` returns inside the tab bar's frame. */
export const LIMRUN_TAB_BUTTONS: readonly IosTreeNode[] = [
  limrunTabButton('Home', 25, ['Selected', 'Button', 'TabButton'], 1),
  limrunTabButton('Catalog', 140, ['Button', 'TabButton'], 0),
  limrunTabButton('Settings', 299, ['TabButton', 'Button'], 0),
];

function limrunTabButton(label: string, x: number, traits: string[], value: number): IosTreeNode {
  return {
    type: 'RadioButton',
    role: 'AXRadioButton',
    subrole: 'AXTabButton',
    role_description: 'tab',
    AXLabel: label,
    AXValue: value,
    traits,
    enabled: true,
    frame: { x, y: 795, width: 78, height: 54 },
    children: [],
  };
}

/**
 * A Limrun session whose `elementTree()` returns `tree` and whose `elementTree(point)` hit-tests
 * `hits`: the first whose frame holds the point, else the deepest tree node that does, as one node.
 */
export function createLimrunHitTestSession(tree: IosTreeNode[], hits: readonly IosTreeNode[]) {
  const probes: { x: number; y: number }[] = [];
  const contains = (node: IosTreeNode, point: { x: number; y: number }) => {
    const frame = node.frame;
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
  };
  const deepestHit = (nodes: readonly IosTreeNode[], point: { x: number; y: number }) => {
    let hit: IosTreeNode | undefined;
    for (const node of nodes) {
      if (!contains(node, point)) continue;
      hit = deepestHit(node.children ?? [], point) ?? node;
    }
    return hit;
  };
  const session = createLimrunSnapshotSession(tree, IPHONE_SCREEN);
  session.client.elementTree = (async (point?: { x: number; y: number }) => {
    if (!point) return tree;
    probes.push(point);
    const hit = hits.find((node) => contains(node, point)) ?? deepestHit(tree, point);
    return { ...hit, children: [] };
  }) as unknown as typeof session.client.elementTree;
  return { session, probes };
}
