import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createDurableCaptureAdmissionLedger } from '../durable-capture-admission-ledger.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'ledger-device',
  name: 'Pixel',
  kind: 'emulator',
};
const otherDevice: DeviceInfo = {
  platform: 'android',
  id: 'other-device',
  name: 'Other Pixel',
  kind: 'emulator',
};

test('blocks only the affected device in this process-lifetime ledger', () => {
  const ledger = createDurableCaptureAdmissionLedger({ displayName: 'Screen recording' });
  ledger.blockUndurableCleanup(device, 'cleanup could not be confirmed');
  expect(() => ledger.assertStartAllowed(device)).toThrow(/process-local/);
  expect(() => ledger.assertStartAllowed(otherDevice)).not.toThrow();
  expect(() =>
    createDurableCaptureAdmissionLedger({ displayName: 'Screen recording' }).assertStartAllowed(
      device,
    ),
  ).not.toThrow();
});

test('expires bounded cleanup uncertainty and reports it once', () => {
  let now = 1_000;
  const expired: string[] = [];
  const ledger = createDurableCaptureAdmissionLedger({
    displayName: 'Screen recording',
    now: () => now,
    undurableCleanupTtlMs: 500,
    onUndurableCleanupExpired: ({ reason }) => expired.push(reason),
  });
  ledger.blockUndurableCleanup(device, 'cleanup could not be confirmed');
  expect(() => ledger.assertStartAllowed(device)).toThrow(/process-local/);
  now += 501;
  expect(() => ledger.assertStartAllowed(device)).not.toThrow();
  expect(expired).toEqual(['cleanup could not be confirmed']);
  expect(() => ledger.assertStartAllowed(device)).not.toThrow();
});

test('clearing a device releases only its recorded uncertainty', () => {
  const ledger = createDurableCaptureAdmissionLedger({ displayName: 'Screen recording' });
  ledger.blockUndurableCleanup(device, 'first');
  ledger.blockUndurableCleanup(otherDevice, 'second');
  ledger.clearUndurableCleanup(device);
  expect(() => ledger.assertStartAllowed(device)).not.toThrow();
  expect(() => ledger.assertStartAllowed(otherDevice)).toThrow(/process-local/);
});
