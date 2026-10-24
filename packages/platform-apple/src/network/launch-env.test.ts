import { expect, test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { buildNetworkCaptureLaunchEnv, NETWORK_CAPTURE_PATH_ENV } from './launch-env.ts';

test('adds only the two SIMCTL_CHILD capture variables as launch overrides', async () => {
  const env = await buildNetworkCaptureLaunchEnv(
    { capturePath: '/sessions/one/network.jsonl' },
    undefined,
    async () => ({ path: '/cache/ADNetworkCapture.dylib' }),
  );

  expect(env).toBeDefined();
  expect(Object.keys(env ?? {})).toEqual([
    'SIMCTL_CHILD_DYLD_INSERT_LIBRARIES',
    `SIMCTL_CHILD_${NETWORK_CAPTURE_PATH_ENV}`,
  ]);
  expect(env!.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES).toBe('/cache/ADNetworkCapture.dylib');
  expect(env![`SIMCTL_CHILD_${NETWORK_CAPTURE_PATH_ENV}`]).toBe('/sessions/one/network.jsonl');
});

test('asks for no capture and gets no environment at all', async () => {
  const env = await buildNetworkCaptureLaunchEnv(undefined, undefined, async () => {
    throw new Error('must not build a probe nobody asked for');
  });
  expect(env).toBeUndefined();
});

test('a probe that cannot be built fails the capture launch with the probe error', async () => {
  const failure = new AppError(
    'COMMAND_FAILED',
    'Unable to build the iOS Simulator network capture probe',
    { reason: 'network-capture-probe-build-failed' },
  );

  await expect(
    buildNetworkCaptureLaunchEnv(
      { capturePath: '/sessions/one/network.jsonl' },
      undefined,
      async () => {
        throw failure;
      },
    ),
  ).rejects.toBe(failure);
});
