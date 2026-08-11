import { expect, test } from 'vitest';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import { createNextAppLogFence } from '../app-log-start-preflight.ts';
import { appLogResourceStore } from '../app-log-resource-store.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'ledger-device',
  name: 'Pixel',
  kind: 'emulator',
};

const OTHER_DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'other-ledger-device',
  name: 'Other Pixel',
  kind: 'emulator',
};

test('an undurable cleanup block is isolated to its daemon-owned admission ledger', () => {
  const blockedLedger = createAppLogAdmissionLedger();
  const restartedDaemonLedger = createAppLogAdmissionLedger();
  const sessionStore = makeSessionStore('app-log-admission-ledger-');
  const resourcePath = appLogResourceStore.resolvePath(sessionStore.resolveSessionDir('session'));

  blockedLedger.blockUndurableCleanup(DEVICE, 'cleanup could not be confirmed');

  expect(() =>
    createNextAppLogFence({ ledger: blockedLedger, resourcePath, device: DEVICE }),
  ).toThrow(/process-local/);
  expect(
    createNextAppLogFence({ ledger: restartedDaemonLedger, resourcePath, device: DEVICE })
      .generation,
  ).toBe(1);
});

test('retained legacy markers fail closed only in the daemon ledger that observed them', () => {
  const retainingLedger = createAppLogAdmissionLedger({ markerExists: () => true });
  const restartedDaemonLedger = createAppLogAdmissionLedger();
  const sessionStore = makeSessionStore('app-log-admission-legacy-ledger-');
  const resourcePath = appLogResourceStore.resolvePath(sessionStore.resolveSessionDir('session'));

  retainingLedger.retainLegacyMarkers([
    { markerPath: '/sessions/legacy/app-log.pid', device: deviceIdentity(DEVICE) },
  ]);

  expect(() =>
    createNextAppLogFence({ ledger: retainingLedger, resourcePath, device: DEVICE }),
  ).toThrow(/legacy app-log marker/);
  expect(
    createNextAppLogFence({ ledger: restartedDaemonLedger, resourcePath, device: DEVICE })
      .generation,
  ).toBe(1);
  expect(
    createNextAppLogFence({ ledger: retainingLedger, resourcePath, device: OTHER_DEVICE })
      .generation,
  ).toBe(1);
});

test('an unclassified legacy marker does not globally wedge unrelated device admission', () => {
  const ledger = createAppLogAdmissionLedger({ markerExists: () => true });
  const sessionStore = makeSessionStore('app-log-admission-unclassified-legacy-');
  const resourcePath = appLogResourceStore.resolvePath(sessionStore.resolveSessionDir('session'));

  ledger.retainLegacyMarkers([{ markerPath: '/sessions/corrupt/app-log.pid' }]);

  expect(createNextAppLogFence({ ledger, resourcePath, device: DEVICE }).generation).toBe(1);
  expect(createNextAppLogFence({ ledger, resourcePath, device: OTHER_DEVICE }).generation).toBe(1);
});

test('removing a retained legacy marker unblocks the matching device without a daemon restart', () => {
  let markerExists = true;
  const ledger = createAppLogAdmissionLedger({ markerExists: () => markerExists });
  const sessionStore = makeSessionStore('app-log-admission-removed-marker-');
  const resourcePath = appLogResourceStore.resolvePath(sessionStore.resolveSessionDir('session'));

  ledger.retainLegacyMarkers([
    { markerPath: '/sessions/legacy/app-log.pid', device: deviceIdentity(DEVICE) },
  ]);
  expect(() => createNextAppLogFence({ ledger, resourcePath, device: DEVICE })).toThrow(
    /legacy app-log marker/,
  );

  markerExists = false;
  expect(createNextAppLogFence({ ledger, resourcePath, device: DEVICE }).generation).toBe(1);
});

test('undurable cleanup blocks expire within the configured bound and report a diagnostic', () => {
  let now = 1_000;
  const expired: string[] = [];
  const ledger = createAppLogAdmissionLedger({
    now: () => now,
    undurableCleanupTtlMs: 500,
    onUndurableCleanupExpired: ({ reason }) => expired.push(reason),
  });
  const sessionStore = makeSessionStore('app-log-admission-expiry-');
  const resourcePath = appLogResourceStore.resolvePath(sessionStore.resolveSessionDir('session'));

  ledger.blockUndurableCleanup(DEVICE, 'cleanup could not be confirmed');
  expect(() => createNextAppLogFence({ ledger, resourcePath, device: DEVICE })).toThrow(
    /process-local/,
  );

  now += 501;
  expect(createNextAppLogFence({ ledger, resourcePath, device: DEVICE }).generation).toBe(1);
  expect(expired).toEqual(['cleanup could not be confirmed']);
});
