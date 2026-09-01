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
      elementTree: async () => JSON.stringify(tree),
      deviceInfo: { screenWidth: screen.width, screenHeight: screen.height },
    },
  } as Pick<LimrunIosSession, 'client' | 'instanceId'>;
}
