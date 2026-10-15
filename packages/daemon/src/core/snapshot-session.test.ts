import { afterEach, expect, test } from 'vitest';
import { IOS_SIMULATOR } from '@agent-device/test-kit/device-fixtures';
import { withSessionlessRunnerCleanup } from './snapshot-session.ts';
import { installProviderDeviceAdmission } from './provider-device-admission.ts';
import { platformResourceCleanupFixture } from '../__tests__/support/platform-resource-cleanup-fixture.ts';
import { makeSession } from '../__tests__/support/session-factories.ts';

const returnOk = async () => 'ok';

afterEach(() => {
  installProviderDeviceAdmission({ isActive: () => false });
});

test('sessionless cleanup releases the local execution host after the task', async () => {
  const events: string[] = [];
  const platformCleanup = platformResourceCleanupFixture({
    cleanupSessionlessExecutionHost: async () => {
      events.push('cleanup');
    },
  });

  const result = await withSessionlessRunnerCleanup(
    undefined,
    IOS_SIMULATOR,
    async () => {
      events.push('task');
      return 'ok';
    },
    platformCleanup,
  );

  expect(result).toBe('ok');
  expect(events).toEqual(['task', 'cleanup']);
  expect(platformCleanup.cleanupSessionlessExecutionHost).toHaveBeenCalledWith(IOS_SIMULATOR);
});

test('sessionless cleanup runs when the task fails and keeps the failure', async () => {
  const platformCleanup = platformResourceCleanupFixture();
  const failure = new Error('capture failed');

  await expect(
    withSessionlessRunnerCleanup(
      undefined,
      IOS_SIMULATOR,
      async () => {
        throw failure;
      },
      platformCleanup,
    ),
  ).rejects.toBe(failure);
  expect(platformCleanup.cleanupSessionlessExecutionHost).toHaveBeenCalledWith(IOS_SIMULATOR);
});

test('sessionless cleanup leaves a provider-owned device to its provider', async () => {
  const device = { ...IOS_SIMULATOR, id: 'limrun:ios:lease-a' };
  installProviderDeviceAdmission({ isActive: (candidate) => candidate.id === device.id });
  const platformCleanup = platformResourceCleanupFixture();

  const result = await withSessionlessRunnerCleanup(undefined, device, returnOk, platformCleanup);

  expect(result).toBe('ok');
  expect(platformCleanup.cleanupSessionlessExecutionHost).not.toHaveBeenCalled();
});

test('a session keeps its execution host past the task', async () => {
  const platformCleanup = platformResourceCleanupFixture();

  const result = await withSessionlessRunnerCleanup(
    makeSession('open-session', { device: IOS_SIMULATOR }),
    IOS_SIMULATOR,
    returnOk,
    platformCleanup,
  );

  expect(result).toBe('ok');
  expect(platformCleanup.cleanupSessionlessExecutionHost).not.toHaveBeenCalled();
});

test('sessionless cleanup refuses to run without an injected platform cleanup', async () => {
  await expect(withSessionlessRunnerCleanup(undefined, IOS_SIMULATOR, returnOk)).rejects.toThrow(
    'Platform resource cleanup was not injected',
  );
});
