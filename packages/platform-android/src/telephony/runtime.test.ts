import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('./emulator-console.ts', () => ({ sendAndroidTelephonyEvent: vi.fn() }));

import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type RuntimeFacts,
} from '@agent-device/contracts/platform-runtime';
import {
  telephonyRuntimeUse,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';

import { ANDROID_EMULATOR, UNKNOWN_KIND_DEVICE } from '../runtime.fixtures.ts';
import { sendAndroidTelephonyEvent } from './emulator-console.ts';
import { androidTelephonyFacts, createAndroidTelephonyOperations } from './runtime.ts';

const mockSend = vi.mocked(sendAndroidTelephonyEvent);

const physical: DeviceInfo = { ...ANDROID_EMULATOR, kind: 'device' };

/** A full owner binding whose telephony cell is derived only from the fact under test. */
function telephonyBinding(device: DeviceInfo): DeviceBinding<PlatformRuntimeOperations> {
  const { sendTelephonyEvent } = androidTelephonyFacts(device);
  return {
    device,
    owner: localRuntimeOwner('android'),
    facts: {
      device: { ...deviceShape(device), providerMode: 'local' },
      operations: { sendTelephonyEvent } as RuntimeFacts<PlatformRuntimeOperations>['operations'],
    },
    operations: createAndroidTelephonyOperations({ device, signal: new AbortController().signal }),
    [Symbol.asyncDispose]: async () => {},
  };
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(undefined);
});

test('an emulator admits sendTelephonyEvent and binds it to the bound signal', async () => {
  expect(androidTelephonyFacts(ANDROID_EMULATOR).sendTelephonyEvent).toEqual({ available: true });
  const { signal } = new AbortController();
  const operations = createAndroidTelephonyOperations({ device: ANDROID_EMULATOR, signal });

  const input = { action: 'sms', number: '5551234', text: 'hello' } as const;
  await operations.sendTelephonyEvent?.(input);
  expect(mockSend).toHaveBeenCalledWith(ANDROID_EMULATOR, input, { signal });
});

test('a physical device and an unknown kind refuse sendTelephonyEvent with the typed kind fact', () => {
  for (const device of [physical, UNKNOWN_KIND_DEVICE]) {
    expect(androidTelephonyFacts(device).sendTelephonyEvent).toMatchObject({
      available: false,
      reason: 'unsupported-device-kind',
      hint: expect.stringContaining('physical device has no console'),
    });
    const operations = createAndroidTelephonyOperations({
      device,
      signal: new AbortController().signal,
    });
    expect(operations).not.toHaveProperty('sendTelephonyEvent');
  }
  expect(mockSend).not.toHaveBeenCalled();
});

test('the narrowed telephony use refuses a physical device as UNSUPPORTED_OPERATION', () => {
  expect(() => narrowDeviceBinding(telephonyBinding(physical), telephonyRuntimeUse)).toThrow(
    expect.objectContaining({
      code: 'UNSUPPORTED_OPERATION',
      details: expect.objectContaining({ reason: 'unsupported-device-kind' }),
    }),
  );
});

test('an aborted scope never reaches the emulator console', async () => {
  const controller = new AbortController();
  const operations = createAndroidTelephonyOperations({
    device: ANDROID_EMULATOR,
    signal: controller.signal,
  });
  controller.abort();
  await expect(
    operations.sendTelephonyEvent?.({ action: 'call', number: '5551234' }),
  ).rejects.toThrow();
  expect(mockSend).not.toHaveBeenCalled();
});
