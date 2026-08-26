import { expect, test, vi } from 'vitest';
import { IOS_SIMULATOR } from '../../../../__tests__/test-utils/device-fixtures.ts';

const { runAppleRunnerCommand } = vi.hoisted(() => ({
  runAppleRunnerCommand: vi.fn(async () => ({ found: true })),
}));

vi.mock('../runner-client.ts', () => ({ runAppleRunnerCommand }));

import { queryAppleRunnerSelector } from '../runner-selector-query.ts';

test('builds the one querySelector runner command for every caller', async () => {
  const options = { requestId: 'request-1' };
  await expect(
    queryAppleRunnerSelector(
      IOS_SIMULATOR,
      { key: 'id', value: 'submit' },
      'com.example.app',
      options,
    ),
  ).resolves.toEqual({ found: true });

  expect(runAppleRunnerCommand).toHaveBeenCalledWith(
    IOS_SIMULATOR,
    {
      command: 'querySelector',
      selectorKey: 'id',
      selectorValue: 'submit',
      appBundleId: 'com.example.app',
    },
    options,
  );
});
