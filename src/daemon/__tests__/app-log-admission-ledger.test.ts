import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAppLogAdmissionLedger } from '../app-log-admission-ledger.ts';
import { createNextAppLogFence } from '../app-log-start-preflight.ts';
import { resolveAppLogResourcePath } from '../app-log-resource-store.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

const DEVICE: DeviceInfo = {
  platform: 'android',
  id: 'ledger-device',
  name: 'Pixel',
  kind: 'emulator',
};

test('an undurable cleanup block is isolated to its daemon-owned admission ledger', () => {
  const blockedLedger = createAppLogAdmissionLedger();
  const restartedDaemonLedger = createAppLogAdmissionLedger();
  const sessionStore = makeSessionStore('app-log-admission-ledger-');
  const resourcePath = resolveAppLogResourcePath(sessionStore.resolveSessionDir('session'));

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
  const retainingLedger = createAppLogAdmissionLedger();
  const restartedDaemonLedger = createAppLogAdmissionLedger();
  const sessionStore = makeSessionStore('app-log-admission-legacy-ledger-');
  const resourcePath = resolveAppLogResourcePath(sessionStore.resolveSessionDir('session'));

  retainingLedger.retainLegacyMarkers(['/sessions/legacy/app-log.pid']);

  expect(() =>
    createNextAppLogFence({ ledger: retainingLedger, resourcePath, device: DEVICE }),
  ).toThrow(/legacy app-log marker/);
  expect(
    createNextAppLogFence({ ledger: restartedDaemonLedger, resourcePath, device: DEVICE })
      .generation,
  ).toBe(1);
});
