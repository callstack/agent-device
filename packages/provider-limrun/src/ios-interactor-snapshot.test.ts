import { expect, test } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

test('limrun iOS snapshot stamps the xctest channel with its own producer', async () => {
  const session = {
    platform: 'ios',
    client: {
      elementTree: async () => ({
        elementType: 'Application',
        frame: { x: 0, y: 0, width: 320, height: 240 },
        children: [{ elementType: 'Button', label: 'Continue', enabled: true }],
      }),
      deviceInfo: { screenWidth: 320, screenHeight: 240 },
    },
  } as unknown as LimrunIosSession;

  const result = await createLimrunIosInteractor(session).snapshot();

  if (!('stage' in result)) throw new Error('Limrun iOS snapshot must carry acquired facts');
  expect(result.stage).toBe('acquired');
  expect(result.acquisition.producer).toBe('limrun-ios-tree');
  expect(result.acquisition.nodes.map((node) => node.label)).toEqual([undefined, 'Continue']);
});

test('Limrun XCTest snapshot retains a non-accessibility React Native testID and its tap frame', async () => {
  const session = {
    platform: 'ios',
    elementTreeSource: 'xcuitest',
    client: {
      elementTree: async (_point?: unknown, options?: { source?: string }) => [
        {
          type: 'Application',
          frame: { x: 0, y: 0, width: 390, height: 844 },
          children:
            options?.source === 'xcuitest'
              ? [
                  {
                    type: 'Other',
                    AXUniqueId: 'xcuitest-only-view',
                    frame: { x: 48, y: 120, width: 200, height: 120 },
                    enabled: true,
                  },
                ]
              : [],
        },
      ],
      deviceInfo: { screenWidth: 390, screenHeight: 844 },
    },
  } as unknown as LimrunIosSession;
  const result = await createLimrunIosInteractor(session).snapshot();
  if (!('stage' in result)) throw new Error('Limrun snapshot must carry acquired facts');
  expect(
    result.acquisition.nodes.find((node) => node.identifier === 'xcuitest-only-view'),
  ).toMatchObject({
    type: 'Other',
    identifier: 'xcuitest-only-view',
    rect: { x: 48, y: 120, width: 200, height: 120 },
  });
});
