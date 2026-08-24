import { expect, test } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';

test('limrun iOS snapshot stamps the xctest channel with its own producer', async () => {
  const session = {
    platform: 'ios',
    client: {
      elementTree: async () =>
        JSON.stringify({
          elementType: 'Application',
          children: [{ elementType: 'Button', label: 'Continue', enabled: true }],
        }),
    },
  } as unknown as LimrunIosSession;

  const result = await createLimrunIosInteractor(session).snapshot();

  expect(result.backend).toBe('xctest');
  expect(result.producer).toBe('limrun-ios-tree');
  expect(result.nodes?.map((node) => node.label)).toEqual([undefined, 'Continue']);
});
