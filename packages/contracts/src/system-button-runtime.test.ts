import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';
import { HARDWARE_BUTTON_NAMES, parseHardwareButtonPositionals } from './device-rotation.ts';
import {
  SYSTEM_BUTTONS,
  SYSTEM_BUTTON_LABELS,
  androidHardwareButtonAvailability,
  bindSystemButton,
  systemButtonRuntimeOperationFacts,
} from './system-button-runtime.ts';

const device = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
} as const;
const available = { available: true } as const;
const unsupported = { available: false, reason: 'unsupported-platform-leaf' } as const;

test('an omitted button reports the family denial, a named one its own cell', () => {
  expect(systemButtonRuntimeOperationFacts({ unsupported, home: available })).toEqual({
    home: available,
    appSwitcher: unsupported,
    actionButton: unsupported,
    volumeUp: unsupported,
    volumeDown: unsupported,
    power: unsupported,
  });
  expect(systemButtonRuntimeOperationFacts({ unsupported })).toEqual({
    home: unsupported,
    appSwitcher: unsupported,
    actionButton: unsupported,
    volumeUp: unsupported,
    volumeDown: unsupported,
    power: unsupported,
  });
});

test.each(SYSTEM_BUTTONS)(
  'a local %s binding presses the interactor once with no arguments',
  async (button) => {
    const press = vi.fn(async () => undefined);
    const resolveInteractor = vi.fn(async () => ({ [button]: press }) as unknown as Interactor);
    const signal = new AbortController().signal;

    const operations = bindSystemButton(
      button,
      signal,
      localInteractorSource({ device, resolveInteractor }),
    );
    await operations[button]({
      options: { appBundleId: 'com.example.app' },
      execution: { logPath: '/tmp/daemon.log', requestId: `${button}-1` },
    });

    expect(resolveInteractor).toHaveBeenCalledWith(device, {
      logPath: '/tmp/daemon.log',
      requestId: `${button}-1`,
      appBundleId: 'com.example.app',
      signal,
    });
    expect(press).toHaveBeenCalledExactlyOnceWith();
  },
);

test('an admitted button whose interactor lacks the member fails closed instead of no-op success', async () => {
  const resolveInteractor = vi.fn(async () => ({}) as unknown as Interactor);
  const operations = bindSystemButton(
    'actionButton',
    new AbortController().signal,
    localInteractorSource({ device, resolveInteractor }),
  );

  await expect(operations.actionButton({})).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'action-button was admitted but its bound interactor has no implementation.',
    details: { reason: 'interactor-method-missing' },
  });
});

// The hardware-button vocabulary the `hardware-button` command routes through: each public name
// maps to exactly one family cell whose family label is the name itself, and an unknown name
// refuses before any device dispatch (#3848).
test('the hardware-button vocabulary is exhaustive over the family cells and parses exactly', () => {
  expect(
    HARDWARE_BUTTON_NAMES.map(
      (name) => SYSTEM_BUTTON_LABELS[parseHardwareButtonPositionals([name])],
    ),
  ).toEqual([...HARDWARE_BUTTON_NAMES]);
  expect(
    [...HARDWARE_BUTTON_NAMES].map((name) => parseHardwareButtonPositionals([name])).sort(),
  ).toEqual(['power', 'volumeDown', 'volumeUp']);
  expect(parseHardwareButtonPositionals(['volume-up'])).toBe('volumeUp');
  expect(parseHardwareButtonPositionals(['Volume-Down'])).toBe('volumeDown');
  expect(parseHardwareButtonPositionals(['power'])).toBe('power');
  for (const name of ['', 'vol', 'mute', 'home', undefined] as const) {
    expect(() => parseHardwareButtonPositionals([name as string])).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: 'hardware-button button must be one of: volume-up, volume-down, power.',
      }),
    );
  }
});

// The whole positional contract one shared helper owns for both the CLI reader and the daemon
// resolver: exactly one name, then the exact-name parse (#3848).
test('the hardware-button positional helper enforces arity and the exact-name parse', () => {
  expect(parseHardwareButtonPositionals(['volume-up'])).toBe('volumeUp');
  for (const positionals of [[], ['volume-up', 'power'], ['power', 'extra']] as const) {
    expect(() => parseHardwareButtonPositionals(positionals)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: 'hardware-button requires exactly one button: volume-up, volume-down, power.',
      }),
    );
  }
  expect(() => parseHardwareButtonPositionals(['mute'])).toThrowError(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  );
});

// The Android hardware-button admission rule both Android owners share: a phone or tablet
// answers available, a TV target refuses toward tv-remote, and the synthetic simulator row has
// no device behind it (#3848).
test('the shared Android hardware-button rule admits phones and refuses TV and simulator', () => {
  expect(androidHardwareButtonAvailability({ kind: 'emulator' })).toEqual({ available: true });
  expect(androidHardwareButtonAvailability({ kind: 'mobile', target: 'phone' })).toEqual({
    available: true,
  });
  expect(androidHardwareButtonAvailability({ kind: 'mobile', target: 'tv' })).toEqual(
    expect.objectContaining({
      available: false,
      reason: 'unsupported-device-kind',
      hint: 'hardware-button is not supported on Android TV targets; use tv-remote.',
    }),
  );
  expect(androidHardwareButtonAvailability({ kind: 'simulator' })).toEqual(
    expect.objectContaining({
      available: false,
      reason: 'unsupported-device-kind',
      hint: 'hardware-button is supported on Android emulators and physical devices.',
    }),
  );
});
