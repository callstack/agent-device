import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test } from 'vitest';
import { limrunIosSimulator as device, limrunOwnerOptions } from './app-log-runtime.fixtures.ts';
import {
  deploymentOptions,
  limrunAppLogFacts,
  limrunAppLogRecoveryFacts,
  limrunLifecycleFacts,
  liveSessionUnavailable,
} from './facts-runtime.ts';

test('limrunAppLogFacts admits the live-session app-log cells', () => {
  const facts = limrunAppLogFacts(limrunOwnerOptions(), device);
  expect(facts.operations.appLogInspect).toEqual({ available: true });
  expect(facts.operations.appLogStart).toEqual({ available: true });
  expect(facts.operations.networkDump).toEqual({ available: true });
});

test('limrunAppLogRecoveryFacts closes the live-only cells but keeps reattach/cleanup available', () => {
  const facts = limrunAppLogRecoveryFacts(limrunOwnerOptions(), device);
  expect(facts.operations.appLogInspect).toEqual(liveSessionUnavailable);
  expect(facts.operations.appLogStart).toEqual(liveSessionUnavailable);
  expect(facts.operations.networkDump).toEqual(liveSessionUnavailable);
  expect(facts.operations.appLogReattach).toEqual({ available: true });
  expect(facts.operations.appLogCleanup).toEqual({ available: true });
});

test('deploymentOptions forwards hasLiveSession as isSessionActive', () => {
  const options = limrunOwnerOptions({ hasLiveSession: () => false });
  expect(deploymentOptions(options).isSessionActive?.(device)).toBe(false);
});

test('limrunLifecycleFacts refuses open/close for a device Limrun app logs do not recognize', () => {
  const unsupportedDevice: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    id: 'some-other-provider:ios:lease-a',
    name: 'Not a Limrun device',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  };
  const facts = limrunLifecycleFacts(unsupportedDevice, true);
  expect(facts.resolveOpenTarget).toMatchObject({
    available: false,
    hint: 'Limrun open requires a Limrun-owned iOS simulator or Android emulator.',
  });
  expect(facts.closeApplication).toMatchObject({
    available: false,
    hint: 'Limrun close requires a Limrun-owned iOS simulator or Android emulator.',
  });
});

test('limrunLifecycleFacts requires a live session to open/close a recognized device', () => {
  const facts = limrunLifecycleFacts(device, false);
  expect(facts.resolveOpenTarget).toEqual(liveSessionUnavailable);
  expect(facts.closeApplication).toEqual(liveSessionUnavailable);
});

test('limrunLifecycleFacts gates port reverse to a live Android session', () => {
  const androidDevice: DeviceInfo = {
    platform: 'android',
    id: 'limrun:android:lease-a',
    name: 'Limrun Android',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
  expect(limrunLifecycleFacts(androidDevice, true).configureProviderPortReverse).toEqual({
    available: true,
  });
  expect(limrunLifecycleFacts(device, true).configureProviderPortReverse).toMatchObject({
    available: false,
    hint: 'Limrun port reverse requires an active Android Limrun session.',
  });
});
