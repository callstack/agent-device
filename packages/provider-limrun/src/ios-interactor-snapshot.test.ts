import { expect, test } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

test('limrun iOS snapshot stamps the xctest channel with its own producer', async () => {
  const session = {
    platform: 'ios',
    client: {
      elementTree: async () =>
        JSON.stringify({
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
