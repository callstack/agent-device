import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../platforms/apple/core/runner-client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platforms/apple/core/runner-client.ts')>()),
  stopIosRunnerSession: vi.fn(async () => {}),
}));
vi.mock('../../../platforms/apple/core/apps.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platforms/apple/core/apps.ts')>()),
  closeIosApp: vi.fn(async () => {}),
}));

import { withSessionlessRunnerCleanup } from '../snapshot-session.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import { stopIosRunnerSession } from '../../../platforms/apple/core/runner-client.ts';
import { closeIosApp } from '../../../platforms/apple/core/apps.ts';
import { IOS_SIMULATOR } from '../../../__tests__/test-utils/device-fixtures.ts';

const mockStopIosRunnerSession = vi.mocked(stopIosRunnerSession);
const mockCloseIosApp = vi.mocked(closeIosApp);
const returnOk = async () => 'ok';

beforeEach(() => {
  mockStopIosRunnerSession.mockReset().mockResolvedValue();
  mockCloseIosApp.mockReset().mockResolvedValue();
});

test('sessionless iOS runner cleanup stops the runner host app', async () => {
  const result = await withSessionlessRunnerCleanup(
    undefined,
    IOS_SIMULATOR,
    returnOk,
    platformResourceCleanup,
  );
  expect(result).toBe('ok');
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(IOS_SIMULATOR.id);
  expect(mockCloseIosApp).toHaveBeenCalledWith(IOS_SIMULATOR, 'com.callstack.agentdevice.runner');
});

test('sessionless iOS runner host close is best effort', async () => {
  mockCloseIosApp.mockRejectedValueOnce(new Error('terminate failed'));
  const result = await withSessionlessRunnerCleanup(
    undefined,
    IOS_SIMULATOR,
    returnOk,
    platformResourceCleanup,
  );
  expect(result).toBe('ok');
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(IOS_SIMULATOR.id);
  expect(mockCloseIosApp).toHaveBeenCalledWith(IOS_SIMULATOR, 'com.callstack.agentdevice.runner');
});
