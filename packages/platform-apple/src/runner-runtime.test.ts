import { expect, test } from 'vitest';
import { createAppleRunnerRuntime } from './runner-runtime.ts';
import { IOS_SIMULATOR } from './__tests__/device-fixtures.ts';
import type { RunnerContext } from '@agent-device/contracts/interactor-types';
import {
  bindProviderSnapshotInteractor,
  type SnapshotRuntimePresenter,
} from '@agent-device/contracts/snapshot-runtime';

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
          pressReadiness: 'ready',
          pressReadinessAppBundleId: 'com.example.app',
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
  const authorizedTarget = {
    type: 9,
    label: 'Continue',
    rect: { x: 1, y: 2, width: 30, height: 40 },
    point: { x: 16, y: 22 },
  };
  expect(
    await operations.pressReadiness!({
      authorizedTarget,
      appBundleId: options.appBundleId,
      execution,
    }),
  ).toEqual({ readiness: 'ready', appBundleId: options.appBundleId });
  expect(commands.at(-1)).toMatchObject({
    command: 'pressReadiness',
    authorizedTarget,
    appBundleId: options.appBundleId,
  });
  expect(requestIds.at(-1)).toBe('observe-remote');
  const beforeCancel = commands.length;
  controller.abort();
  await expect(
    operations.querySelector({ selector: { key: 'label', value: 'Continue' }, options, execution }),
  ).rejects.toThrow();
  expect(commands).toHaveLength(beforeCancel);
});

test('an observe-only capture on a provider Simulator still fails closed and never reaches the runner', async () => {
  const commands: Record<string, unknown>[] = [];
  const runner = createAppleRunnerRuntime({
    device: IOS_SIMULATOR,
    host: { env: {}, cwd: process.cwd() },
    provider: {
      hasLiveSession: () => true,
      runCommand: async (_device, command) => {
        commands.push(command);
        return {};
      },
    },
  });
  const controller = new AbortController();
  const resolveInteractor = async (_device: typeof IOS_SIMULATOR, context: RunnerContext) =>
    runner.createInteractor(context);
  const present: SnapshotRuntimePresenter = (result) => ({
    backend: 'xctest' as const,
    producer: result.acquisition.producer,
    nodes: [...result.acquisition.nodes],
  });
  const operations = runner.bindRunnerOperations({
    signal: controller.signal,
    resolveInteractor,
    snapshot: {
      capture: bindProviderSnapshotInteractor({
        device: IOS_SIMULATOR,
        signal: controller.signal,
        resolveInteractor: (context) => runner.createInteractor(context),
        presentIosAcquisition: present,
      }),
      present,
    },
  });
  await expect(
    operations.captureSnapshot({ options: { appBundleId: 'com.example.app', observeOnly: true } }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });
  expect(commands).toHaveLength(0);
});
