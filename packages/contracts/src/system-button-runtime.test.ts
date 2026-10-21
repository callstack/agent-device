import { expect, test, vi } from 'vitest';
import type { Interactor } from './interactor-types.ts';
import { localInteractorSource } from './interactor-operation-binding.ts';
import { HARDWARE_BUTTON_NAMES, parseHardwareButtonPositionals } from './device-rotation.ts';
import {
  SYSTEM_BUTTONS,
  SYSTEM_BUTTON_LABELS,
  androidHardwareButtonFacts,
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
  // Every family cell must be named by an owner or take the denial: this full-object equality
  // enumerates all of them, so a new cell that changes the family builder's shape fails here.
  expect(systemButtonRuntimeOperationFacts({ unsupported, home: available })).toEqual({
    home: available,
    appSwitcher: unsupported,
    actionButton: unsupported,
    volumeUp: unsupported,
    volumeDown: unsupported,
    power: unsupported,
    mute: unsupported,
    sleep: unsupported,
    wake: unsupported,
    mediaPlayPause: unsupported,
    mediaNext: unsupported,
    mediaPrevious: unsupported,
    mediaRewind: unsupported,
    mediaFastForward: unsupported,
  });
  const allDenied = systemButtonRuntimeOperationFacts({ unsupported });
  expect(Object.keys(allDenied).sort()).toEqual([...SYSTEM_BUTTONS].sort());
  for (const button of SYSTEM_BUTTONS) expect(allDenied[button]).toEqual(unsupported);
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
    new Set([...HARDWARE_BUTTON_NAMES].map((name) => parseHardwareButtonPositionals([name]))).size,
  ).toBe(HARDWARE_BUTTON_NAMES.length);
  expect(HARDWARE_BUTTON_NAMES.length).toBe(11);
  expect(parseHardwareButtonPositionals(['volume-up'])).toBe('volumeUp');
  expect(parseHardwareButtonPositionals(['Volume-Down'])).toBe('volumeDown');
  expect(parseHardwareButtonPositionals(['media-fast-forward'])).toBe('mediaFastForward');
  for (const name of ['', 'vol', 'media', 'media-pause', 'home', undefined] as const) {
    expect(() => parseHardwareButtonPositionals([name as string])).toThrowError(
      expect.objectContaining({
        code: 'INVALID_ARGS',
        message: `hardware-button button must be one of: ${HARDWARE_BUTTON_NAMES.join(', ')}.`,
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
        message: `hardware-button requires exactly one button: ${HARDWARE_BUTTON_NAMES.join(', ')}.`,
      }),
    );
  }
  expect(() => parseHardwareButtonPositionals(['media'])).toThrowError(
    expect.objectContaining({ code: 'INVALID_ARGS' }),
  );
  // Every extended name parses to its own cell, the way the original three do.
  for (const [name, cell] of [
    ['mute', 'mute'],
    ['sleep', 'sleep'],
    ['wake', 'wake'],
    ['media-play-pause', 'mediaPlayPause'],
    ['media-next', 'mediaNext'],
    ['media-previous', 'mediaPrevious'],
    ['media-rewind', 'mediaRewind'],
    ['media-fast-forward', 'mediaFastForward'],
  ] as const) {
    expect(parseHardwareButtonPositionals([name])).toBe(cell);
  }
});

// The Android hardware-button admission rule both Android owners share: a phone or tablet
// answers available for every declared cell, a TV target refuses toward tv-remote, and the
// synthetic simulator row has no device behind it (#3848).
test('the shared Android hardware-button rule admits phones and refuses TV and simulator', () => {
  const cells = HARDWARE_BUTTON_NAMES.map((name) => parseHardwareButtonPositionals([name]));
  const phone = androidHardwareButtonFacts({ kind: 'mobile', target: 'phone' });
  for (const cell of cells) {
    expect(phone[cell]).toEqual({ available: true });
  }
  const tv = androidHardwareButtonFacts({ kind: 'mobile', target: 'tv' });
  expect(tv.power).toEqual(
    expect.objectContaining({
      available: false,
      reason: 'unsupported-device-kind',
      hint: 'hardware-button is not supported on Android TV targets; use tv-remote.',
    }),
  );
  const synthetic = androidHardwareButtonFacts({ kind: 'simulator' });
  expect(synthetic.mute).toEqual(
    expect.objectContaining({
      available: false,
      reason: 'unsupported-device-kind',
      hint: 'hardware-button is supported on Android emulators and physical devices.',
    }),
  );
});
