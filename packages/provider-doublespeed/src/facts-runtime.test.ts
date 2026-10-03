import { expect, test } from 'vitest';
import {
  deploymentOptions,
  doublespeedLifecycleFacts,
  doublespeedRecoveryFacts,
  doublespeedRuntimeFacts,
  liveSessionUnavailable,
} from './facts-runtime.ts';
import { doublespeedIosDevice as device, doublespeedOwnerOptions } from './runtime.fixtures.ts';

test('live facts admit app logs, app state, snapshots and lifecycle but no port reverse', () => {
  const facts = doublespeedRuntimeFacts(doublespeedOwnerOptions(), device);
  expect(facts.device.providerMode).toBe('provider-runtime');
  expect(facts.operations.appLogStart).toEqual({ available: true });
  expect(facts.operations.appState).toEqual({ available: true });
  expect(facts.operations.networkDump).toEqual({ available: true });
  expect(facts.operations.captureSnapshot).toEqual({ available: true });
  expect(facts.operations.captureSnapshotWithCustomActions).toEqual({ available: true });
  expect(facts.operations.listApps).toEqual({ available: true });
  expect(facts.operations.openApplication).toEqual({ available: true });
  expect(facts.operations.configureProviderPortReverse).toMatchObject({
    available: false,
    hint: 'Doublespeed iOS sessions cannot reach local host ports; use a bridge public URL.',
  });
  expect(facts.operations.shutdownTarget).toMatchObject({ available: false });
});

test('recovery facts close the live-only cells but keep reattach/cleanup available', () => {
  const facts = doublespeedRecoveryFacts(doublespeedOwnerOptions(), device);
  expect(facts.operations.appLogInspect).toEqual(liveSessionUnavailable);
  expect(facts.operations.appLogStart).toEqual(liveSessionUnavailable);
  expect(facts.operations.appState).toEqual(liveSessionUnavailable);
  expect(facts.operations.deployApp).toEqual(liveSessionUnavailable);
  expect(facts.operations.appLogReattach).toEqual({ available: true });
  expect(facts.operations.appLogCleanup).toEqual({ available: true });
});

test('deploymentOptions forwards hasLiveSession as isSessionActive', () => {
  const options = doublespeedOwnerOptions({ hasLiveSession: () => false });
  expect(deploymentOptions(options).isSessionActive?.(device)).toBe(false);
});

test('lifecycle facts refuse open/close for a device the provider does not recognize', () => {
  const facts = doublespeedLifecycleFacts({ ...device, id: 'limrun:ios:lease-a' }, true);
  expect(facts.resolveOpenTarget).toMatchObject({
    available: false,
    hint: 'Doublespeed open requires a Doublespeed-owned iOS simulator.',
  });
  expect(facts.closeApplication).toMatchObject({
    available: false,
    hint: 'Doublespeed close requires a Doublespeed-owned iOS simulator.',
  });
});

test('lifecycle facts require a live session to open/close a recognized device', () => {
  const facts = doublespeedLifecycleFacts(device, false);
  expect(facts.resolveOpenTarget).toEqual(liveSessionUnavailable);
  expect(facts.closeApplication).toEqual(liveSessionUnavailable);
  expect(facts.configureProviderPortReverse).toEqual(liveSessionUnavailable);
});
