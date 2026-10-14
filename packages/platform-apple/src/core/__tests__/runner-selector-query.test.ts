import { expect, test, vi } from 'vitest';
import { IOS_SIMULATOR } from '../../__tests__/device-fixtures.ts';

const { runAppleRunnerCommand } = vi.hoisted(() => ({
  runAppleRunnerCommand: vi.fn(async (): Promise<Record<string, unknown>> => ({ found: true })),
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

test('querySelector interprets native and RN node facts at the runner result seam', async () => {
  runAppleRunnerCommand.mockResolvedValueOnce({
    found: true,
    nodes: [
      { index: 0, type: 'Switch', value: '1' },
      { index: 1, type: 'SecureTextField' },
      { index: 2, type: 'TextField', enabled: false },
      { index: 3, type: 'Other', value: 'checkbox, unchecked' },
    ],
  });
  const result = await queryAppleRunnerSelector(
    IOS_SIMULATOR,
    { key: 'id', value: 'native-on' },
    'com.example.app',
    {},
  );
  expect(result).toMatchObject({
    found: true,
    nodes: [
      { type: 'Switch', value: '1', checked: true },
      { type: 'SecureTextField', editable: true, password: true },
      { type: 'TextField', enabled: false, editable: true, password: false },
      {
        type: 'Other',
        value: 'checkbox, unchecked',
        checked: false,
        iosValueSemantics: { role: 'checkbox' },
      },
    ],
  });
});
