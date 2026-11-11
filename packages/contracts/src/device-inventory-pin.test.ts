import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { parseDevicePinSelector, readDevicePin } from './device-inventory.ts';

const source = { kind: 'project', path: '/project/agent-device.json' } as const;

for (const value of [
  null,
  false,
  0,
  'ios',
  [],
  {},
  { selector: { platform: 'ios' } },
  { source },
  { selector: {}, source },
  { selector: [], source },
  { selector: { platform: 'windows' }, source },
  { selector: { device: 4 }, source },
  { selector: { udid: ' ' }, source },
  { selector: { target: 'mobile' }, source },
  { selector: { platform: 'ios' }, source: null },
  { selector: { platform: 'ios' }, source: { ...source, kind: 'environment' } },
  { selector: { platform: 'ios' }, source: { ...source, path: '' } },
  { selector: { platform: 'ios' }, source: { ...source, path: 4 } },
  { selector: { platform: 'ios' }, source: { ...source, env: 'PIN' } },
  { selector: { platform: 'ios' }, source, flags: {} },
]) {
  test(`invalid wire pin ${JSON.stringify(value)} has a typed refusal`, () => {
    assert.throws(
      () => readDevicePin(value),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_ARGS' &&
        error.details?.reason === 'invalid_device_pin',
    );
  });
}

test('an absent pin stays absent', () => {
  assert.equal(readDevicePin(undefined), undefined);
});

for (const kind of ['user', 'project', 'explicit'] as const) {
  test(`a ${kind} wire pin retains its selector and source`, () => {
    const pin = { selector: { platform: 'ios', udid: 'SIM-1' }, source: { ...source, kind } };
    assert.deepEqual(readDevicePin(pin), pin);
  });
}

test('config selector parsing preserves string values and reports its config source', () => {
  assert.deepEqual(parseDevicePinSelector({ device: ' iPad Pro ' }, 'test config'), {
    device: ' iPad Pro ',
  });
  assert.throws(
    () => parseDevicePinSelector({ platform: 'windows' }, 'test config'),
    (error: unknown) =>
      error instanceof AppError &&
      error.details?.reason === 'invalid_device_pin' &&
      error.details?.pinSource === 'test config',
  );
});
