import { expect, test } from 'vitest';
import { createAppleRunnerRuntime } from './runner-runtime.ts';
import { IOS_SIMULATOR } from './__tests__/device-fixtures.ts';

test('runtime observations use the forwarded runner with request and application scope', async () => {
  const commands: Record<string, unknown>[] = [];
  const requestIds: (string | undefined)[] = [];
  let ready = false;
  const runner = createAppleRunnerRuntime({
    device: IOS_SIMULATOR,
    host: { env: {}, cwd: process.cwd() },
    provider: {
      hasLiveSession: () => ready,
      runCommand: async (_device, command, options) => {
        ready = true;
        commands.push(command);
        requestIds.push(options.requestId);
        return {
          found: true,
          nodes: [{ rect: { x: 1, y: 2, width: 30, height: 40 }, hittable: true }],
          text: 'Continue',
          appBundleId: 'com.example.app',
          state: 'runningForeground',
        };
      },
    },
  });
  const controller = new AbortController();
  const operations = runner.bindRunnerOperations({
    signal: controller.signal,
    resolveInteractor: async (_device, context) => runner.createInteractor(context),
    snapshot: {
      capture: {
        captureSnapshot: async () => ({
          backend: 'xctest' as const,
          producer: 'apple-runner' as const,
          nodes: [],
        }),
        captureSnapshotWithCustomActions: async () => ({
          backend: 'xctest' as const,
          producer: 'apple-runner' as const,
          nodes: [],
        }),
        captureSnapshotWithoutActiveApp: async () => ({
          backend: 'xctest' as const,
          producer: 'apple-runner' as const,
          nodes: [],
        }),
      },
      present: (result) => ({
        backend: 'xctest' as const,
        producer: result.acquisition.producer,
        nodes: [...result.acquisition.nodes],
      }),
    },
  });
  expect(await operations.appState({ appBundleId: 'com.example.app' })).toEqual({});
  await runner.resetTarget();
  expect(commands).toHaveLength(0);
  await runner.prepare(
    {
      execution: { requestId: 'prepare-remote' },
      timeoutMs: 1000,
    },
    controller.signal,
  );
  expect(commands.at(-1)?.command).toBe('uptime');
  expect(requestIds.at(-1)).toBe('prepare-remote');
  await runner.resetTarget();
  expect(commands.at(-1)?.command).toBe('targetReset');
  const options = { appBundleId: 'com.example.app' };
  const execution = { requestId: 'observe-remote' };
  expect(
    await operations.querySelector({
      selector: { key: 'label', value: 'Continue' },
      options,
      execution,
    }),
  ).toEqual({
    found: true,
    node: { rect: { x: 1, y: 2, width: 30, height: 40 }, hittable: true },
  });
  expect(commands.at(-1)).toMatchObject({
    command: 'querySelector',
    appBundleId: 'com.example.app',
    selectorValue: 'Continue',
  });
  expect(requestIds.at(-1)).toBe('observe-remote');
  expect(await operations.findText({ text: 'Continue', options, execution })).toEqual({
    found: true,
  });
  expect(commands.at(-1)).toMatchObject({ command: 'findText', appBundleId: 'com.example.app' });
  expect(requestIds.at(-1)).toBe('observe-remote');
  expect(await operations.readTextAtPoint({ point: { x: 1, y: 2 }, options, execution })).toEqual({
    status: 'read',
    text: 'Continue',
  });
  expect(commands.at(-1)).toMatchObject({ command: 'readText', appBundleId: 'com.example.app' });
  expect(requestIds.at(-1)).toBe('observe-remote');
  const beforeCancel = commands.length;
  controller.abort();
  await expect(
    operations.querySelector({ selector: { key: 'label', value: 'Continue' }, options, execution }),
  ).rejects.toThrow();
  expect(commands).toHaveLength(beforeCancel);
});
