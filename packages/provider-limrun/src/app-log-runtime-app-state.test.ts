import { expect, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { createLimrunPlatformRuntimeOwner } from './app-log-runtime.ts';
import {
  limrunIosSimulator as device,
  limrunOwnerOptions,
  limrunScope as scope,
} from './app-log-runtime.fixtures.ts';
import { createTestIosRunner } from './ios-runner.fixtures.ts';

test('iOS appstate reads the shared runner without a second instance probe', async () => {
  const commands: Record<string, unknown>[] = [];
  const runner = await createTestIosRunner((command) => {
    commands.push(command);
    return { applicationState: 'runningForeground' };
  });
  const getAppState = vi.fn(async () => ({}));
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      getIosRunner: () => runner,
      getInteractor: (_device, context) => runner.createInteractor(context),
      getAppState,
    }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  await expect(binding.operations.appState!({ appBundleId: 'com.example.app' })).resolves.toEqual({
    applicationState: 'runningForeground',
  });
  expect(commands).toMatchObject([{ command: 'appState', appBundleId: 'com.example.app' }]);
  expect(getAppState).not.toHaveBeenCalled();
});

test('iOS appstate refuses an unreachable instance when the shared runner has no state', async () => {
  const cause = new AppError('COMMAND_FAILED', 'Instance is gone', {
    reason: 'limrun_instance_unreachable',
  });
  const getAppState = vi.fn(async () => {
    throw cause;
  });
  const owner = createLimrunPlatformRuntimeOwner(limrunOwnerOptions({ getAppState }));
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  await expect(binding.operations.appState!()).rejects.toBe(cause);
  expect(getAppState).toHaveBeenCalledWith(device, scope.signal);
});

test('iOS appstate propagates a failed runner read instead of falling back to the live instance probe', async () => {
  const cause = new AppError('COMMAND_FAILED', 'Runner connection lost');
  const runner = await createTestIosRunner(() => {
    throw cause;
  });
  const getAppState = vi.fn(async () => ({}));
  const owner = createLimrunPlatformRuntimeOwner(
    limrunOwnerOptions({
      getIosRunner: () => runner,
      getInteractor: (_device, context) => runner.createInteractor(context),
      getAppState,
    }),
  );
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });
  await expect(binding.operations.appState!({ appBundleId: 'com.example.app' })).rejects.toBe(
    cause,
  );
  expect(getAppState).not.toHaveBeenCalled();
});
