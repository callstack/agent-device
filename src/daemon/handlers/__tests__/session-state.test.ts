import { test, expect, vi } from 'vitest';

import { handleSessionStateCommands } from '../session-state.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { withTestDeviceInventory } from '../../../__tests__/test-utils/device-inventory-gateways.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../../__tests__/test-utils/runtime-operation-facts.ts';
import {
  appStateUse,
  applicationLifecycleOperationFacts,
  createUnavailablePlatformRuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
} from '@agent-device/contracts/platform';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import type { BindDeviceRuntime } from '../../request-runtime-binding.ts';

test('boot rejects --headless outside Android directly', async () => {
  const device = {
    platform: 'apple' as const,
    appleOs: 'ios' as const,
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator' as const,
    target: 'mobile' as const,
    booted: false,
  };
  const response = await withTestDeviceInventory(
    { local: async () => [device] },
    async () =>
      await handleSessionStateCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'boot',
          positionals: [],
          flags: { platform: 'ios', headless: true },
        },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-session-state-'),
        inspectFacts: async () =>
          createUnavailablePlatformRuntimeFacts(device, localRuntimeOwner('apple'), {
            appLog: { available: false, reason: 'owner-capability-missing' },
            network: { available: false, reason: 'owner-capability-missing' },
            screenshot: { available: false, reason: 'owner-capability-missing' },
            viewport: { available: false, reason: 'owner-capability-missing' },
            elementText: { available: false, reason: 'owner-capability-missing' },
            readiness: { available: false, reason: 'unsupported-device-kind' },
            lifecycle: applicationLifecycleOperationFacts({
              resolveOpenTarget: { available: false, reason: 'owner-capability-missing' },
              prepareApplicationOpen: { available: false, reason: 'owner-capability-missing' },
              openApplication: { available: false, reason: 'owner-capability-missing' },
              applyRuntimeHints: { available: false, reason: 'owner-capability-missing' },
              clearRuntimeHints: { available: false, reason: 'owner-capability-missing' },
              closeApplication: { available: false, reason: 'owner-capability-missing' },
              finalizeApplicationClose: { available: false, reason: 'owner-capability-missing' },
              prepareAppleRunner: { available: false, reason: 'owner-capability-missing' },
              configureProviderPortReverse: {
                available: false,
                reason: 'owner-capability-missing',
              },
            }),
          }),
      }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/supported only for Android emulators/i);
  }
});

test('appstate returns missing-session error for explicit session flag', async () => {
  const response = await handleSessionStateCommands({
    req: {
      token: 't',
      session: 'named',
      command: 'appstate',
      positionals: [],
      flags: { platform: 'ios', session: 'named' },
    },
    sessionName: 'named',
    sessionStore: makeSessionStore('agent-device-session-state-'),
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/Run open with --session named first/i);
  }
});

test('appstate rejects web before Android app-state backend dispatch', async () => {
  const device = {
    platform: 'web' as const,
    id: 'agent-browser-chrome',
    name: 'Agent Browser Chrome',
    kind: 'device' as const,
    target: 'desktop' as const,
    booted: true,
  };
  let bound = false;
  const bindDevice: BindDeviceRuntime = async () => {
    bound = true;
    throw new Error('unsupported appstate must not bind');
  };
  const response = await withTestDeviceInventory(
    {
      local: async () => [device],
    },
    async () =>
      await handleSessionStateCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'appstate',
          positionals: [],
          flags: { platform: 'web' },
        },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-session-state-'),
        bindDevice,
        inspectFacts: async () =>
          createUnavailablePlatformRuntimeFacts(device, localRuntimeOwner('web'), {
            appLog: { available: false, reason: 'unsupported-platform-leaf' },
            appState: { available: false, reason: 'unsupported-platform-leaf' },
            network: { available: false, reason: 'unsupported-platform-leaf' },
            screenshot: { available: false, reason: 'unsupported-platform-leaf' },
            viewport: { available: false, reason: 'unsupported-platform-leaf' },
            elementText: { available: false, reason: 'unsupported-platform-leaf' },
            readiness: { available: false, reason: 'unsupported-platform-leaf' },
            lifecycle: applicationLifecycleOperationFacts({
              resolveOpenTarget: { available: false, reason: 'unsupported-platform-leaf' },
              prepareApplicationOpen: { available: false, reason: 'unsupported-platform-leaf' },
              openApplication: { available: false, reason: 'unsupported-platform-leaf' },
              applyRuntimeHints: { available: false, reason: 'unsupported-platform-leaf' },
              clearRuntimeHints: { available: false, reason: 'unsupported-platform-leaf' },
              closeApplication: { available: false, reason: 'unsupported-platform-leaf' },
              finalizeApplicationClose: { available: false, reason: 'unsupported-platform-leaf' },
              prepareAppleRunner: { available: false, reason: 'unsupported-platform-leaf' },
              configureProviderPortReverse: {
                available: false,
                reason: 'unsupported-platform-leaf',
              },
            }),
          }),
      }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/appstate is not supported on web/i);
  }
  expect(bound).toBe(false);
});

test('appstate rejects a missing readiness fact even when appState is available', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'android-device-1',
    name: 'Android Device',
    kind: 'device',
    target: 'mobile',
    booted: true,
  };
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: { available: false, reason: 'owner-capability-missing' },
      appLogDoctor: { available: false, reason: 'owner-capability-missing' },
      appLogStart: { available: false, reason: 'owner-capability-missing' },
      appLogReattach: { available: false, reason: 'owner-capability-missing' },
      appLogCleanup: { available: false, reason: 'owner-capability-missing' },
      appState: { available: true },
      listApps: { available: false, reason: 'owner-capability-missing' },
      networkDump: { available: false, reason: 'owner-capability-missing' },
      screenRecordingStart: { available: false, reason: 'owner-capability-missing' },
      screenRecordingReattach: { available: false, reason: 'owner-capability-missing' },
      screenRecordingCleanup: { available: false, reason: 'owner-capability-missing' },
      ensureReady: {
        available: false,
        reason: 'unsupported-device-kind',
        hint: 'readiness is unavailable for this device kind',
      },
      bootTarget: { available: false, reason: 'unsupported-device-kind' },
      bootTargetHeadless: { available: false, reason: 'unsupported-device-kind' },
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: { available: false, reason: 'unsupported-device-kind' },
        prepareApplicationOpen: { available: false, reason: 'unsupported-device-kind' },
        openApplication: { available: false, reason: 'unsupported-device-kind' },
        applyRuntimeHints: { available: false, reason: 'unsupported-device-kind' },
        clearRuntimeHints: { available: false, reason: 'unsupported-device-kind' },
        closeApplication: { available: false, reason: 'unsupported-device-kind' },
        finalizeApplicationClose: { available: false, reason: 'unsupported-device-kind' },
        prepareAppleRunner: { available: false, reason: 'unsupported-device-kind' },
        configureProviderPortReverse: { available: false, reason: 'unsupported-device-kind' },
      }),
    },
  };
  const inspectFacts = vi.fn(async () => facts);
  let bound = false;
  const bindDevice: BindDeviceRuntime = async () => {
    bound = true;
    throw new Error('missing readiness must not bind');
  };
  const response = await withTestDeviceInventory(
    { local: async () => [device] },
    async () =>
      await handleSessionStateCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'appstate',
          positionals: [],
          flags: { platform: 'android', device: device.name },
        },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-session-state-'),
        inspectFacts,
        bindDevice,
      }),
  );

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.hint).toMatch(/readiness is unavailable/i);
  }
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(bound).toBe(false);
});

test('sessionless Android appstate inspects once, binds once, and preserves operation order', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
  const unavailable = { available: false, reason: 'owner-capability-missing' } as const;
  const available = { available: true } as const;
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: available,
      listApps: unavailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: available,
      bootTarget: available,
      bootTargetHeadless: unavailable,
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: unavailable,
        prepareApplicationOpen: unavailable,
        openApplication: unavailable,
        applyRuntimeHints: unavailable,
        clearRuntimeHints: unavailable,
        closeApplication: unavailable,
        finalizeApplicationClose: unavailable,
        prepareAppleRunner: unavailable,
        configureProviderPortReverse: unavailable,
      }),
    },
  };
  const events: string[] = [];
  const binding: DeviceBinding<PlatformRuntimeOperations> = {
    device,
    owner: localRuntimeOwner('android'),
    facts,
    operations: {
      ensureReady: async (input) => {
        events.push(`ensureReady:${JSON.stringify(input)}`);
        return { ...device, booted: true };
      },
      appState: async () => {
        events.push('appState');
        return { package: 'com.example.app', activity: '.MainActivity' };
      },
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
  const inspectFacts = vi.fn(async () => {
    events.push('inspectFacts');
    return facts;
  });
  const bindDevice: BindDeviceRuntime = async (selected, use) => {
    events.push('bindDevice');
    expect(selected).toEqual(device);
    expect(use).toBe(appStateUse);
    return narrowDeviceBinding(binding, use);
  };

  const response = await withTestDeviceInventory(
    { local: async () => [device] },
    async () =>
      await handleSessionStateCommands({
        req: {
          token: 't',
          session: 'default',
          command: 'appstate',
          positionals: [],
          flags: {
            platform: 'android',
            device: 'Pixel Emulator',
            androidDeviceAllowlist: 'emulator-5555,emulator-5554',
          },
        },
        sessionName: 'default',
        sessionStore: makeSessionStore('agent-device-session-state-'),
        inspectFacts,
        bindDevice,
      }),
  );

  expect(response).toEqual({
    ok: true,
    data: {
      platform: 'android',
      package: 'com.example.app',
      activity: '.MainActivity',
    },
  });
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(events).toEqual([
    'inspectFacts',
    'bindDevice',
    'ensureReady:{"androidSerialAllowlist":["emulator-5554","emulator-5555"]}',
    'appState',
  ]);
});
