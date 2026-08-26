import { expect, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { AppleOS, DeviceInfo } from '@agent-device/kernel/device';
import { appleSystemFacts, createAppleSystemOperations } from './runtime.ts';

function appleDevice(
  appleOs: AppleOS,
  kind: DeviceInfo['kind'],
  overrides: Partial<DeviceInfo> = {},
): DeviceInfo {
  return {
    platform: 'apple',
    appleOs,
    id: `${appleOs}-${kind}`,
    name: `${appleOs} ${kind}`,
    kind,
    booted: true,
    ...overrides,
  };
}

/**
 * The R55 parity cell table, restated as facts. The retired admission was the `clipboard`
 * capability bucket (`{ simulator: true, device: true }`) intersected with the Apple plugin's
 * `supportsHostOrSimulatorSurface` closure — `macos || simulator`. Every row below is that
 * verdict; the one deliberate narrowing is watchOS, which the bucket admitted as a simulator but
 * for which no XCUITest interactor can be constructed at all (the same reading `appleBackFact`
 * takes).
 */
test.each([
  { appleOs: 'ios', kind: 'simulator', expected: true },
  { appleOs: 'ios', kind: 'device', expected: false },
  { appleOs: 'ipados', kind: 'simulator', expected: true },
  { appleOs: 'ipados', kind: 'device', expected: false },
  { appleOs: 'tvos', kind: 'simulator', expected: true },
  { appleOs: 'tvos', kind: 'device', expected: false },
  { appleOs: 'visionos', kind: 'simulator', expected: true },
  { appleOs: 'visionos', kind: 'device', expected: false },
  { appleOs: 'macos', kind: 'device', expected: true },
  { appleOs: 'watchos', kind: 'simulator', expected: false },
] as const)(
  'clipboard on an Apple $appleOs $kind is available: $expected',
  ({ appleOs, kind, expected }) => {
    const facts = appleSystemFacts(appleDevice(appleOs, kind));
    expect(facts.readClipboard.available).toBe(expected);
    expect(facts.writeClipboard.available).toBe(expected);
  },
);

/**
 * `trigger-app-event` carried no Apple admission closure at all: its retired bucket was
 * `{ simulator, device }` flat, so every leaf with a constructible interactor admits it — macOS
 * included, unlike clipboard.
 */
test.each([
  { appleOs: 'ios', kind: 'simulator', expected: true },
  { appleOs: 'ios', kind: 'device', expected: true },
  { appleOs: 'macos', kind: 'device', expected: true },
  { appleOs: 'tvos', kind: 'simulator', expected: true },
  { appleOs: 'watchos', kind: 'simulator', expected: false },
] as const)(
  'trigger-app-event on an Apple $appleOs $kind is available: $expected',
  ({ appleOs, kind, expected }) => {
    expect(appleSystemFacts(appleDevice(appleOs, kind)).triggerAppEvent.available).toBe(expected);
  },
);

/**
 * `settings` shares clipboard's exact reading, and that sharing is the parity claim: the retired
 * admission intersected the `settings` bucket (`{ simulator: true, device: true }`) with the same
 * `supportsHostOrSimulatorSurface` closure. Only the refusal wording differs, so the table is
 * clipboard's verbatim — including the watchOS narrowing.
 */
test.each([
  { appleOs: 'ios', kind: 'simulator', expected: true },
  { appleOs: 'ios', kind: 'device', expected: false },
  { appleOs: 'ipados', kind: 'simulator', expected: true },
  { appleOs: 'ipados', kind: 'device', expected: false },
  { appleOs: 'tvos', kind: 'simulator', expected: true },
  { appleOs: 'tvos', kind: 'device', expected: false },
  { appleOs: 'visionos', kind: 'simulator', expected: true },
  { appleOs: 'visionos', kind: 'device', expected: false },
  { appleOs: 'macos', kind: 'device', expected: true },
  { appleOs: 'watchos', kind: 'simulator', expected: false },
] as const)(
  'settings on an Apple $appleOs $kind is available: $expected',
  ({ appleOs, kind, expected }) => {
    expect(appleSystemFacts(appleDevice(appleOs, kind)).setSetting.available).toBe(expected);
  },
);

// Same cell, different sentence: a physical iOS device is refused as a platform leaf, and the
// hint names the two surfaces that do work rather than clipboard's shorter phrasing.
test('a physical non-macOS Apple device refuses settings as a platform leaf', () => {
  expect(appleSystemFacts(appleDevice('ios', 'device')).setSetting).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
    hint: 'settings is supported on Apple simulators and the macOS host, not on physical devices of this OS.',
  });
});

/**
 * `alert`'s retired admission was the host-or-simulator closure widened by one leaf: physical
 * iOS, whose XCTest alert path is device-verified. Every other physical Apple leaf stays closed
 * exactly as `supportsAlertSurface` left it, and watchOS narrows for want of an interactor.
 */
test.each([
  { appleOs: 'ios', kind: 'simulator', expected: true },
  { appleOs: 'ios', kind: 'device', expected: true },
  { appleOs: 'ipados', kind: 'simulator', expected: true },
  { appleOs: 'ipados', kind: 'device', expected: false },
  { appleOs: 'tvos', kind: 'simulator', expected: true },
  { appleOs: 'tvos', kind: 'device', expected: false },
  { appleOs: 'visionos', kind: 'simulator', expected: true },
  { appleOs: 'visionos', kind: 'device', expected: false },
  { appleOs: 'macos', kind: 'device', expected: true },
  { appleOs: 'watchos', kind: 'simulator', expected: false },
] as const)(
  'alert on an Apple $appleOs $kind is available: $expected',
  ({ appleOs, kind, expected }) => {
    const facts = appleSystemFacts(appleDevice(appleOs, kind));
    // One cell, four legs: an Apple backend that can read a sheet can press its buttons too.
    for (const leg of ['readAlert', 'awaitAlert', 'acceptAlert', 'dismissAlert'] as const) {
      expect(facts[leg].available).toBe(expected);
    }
  },
);

test('a non-simulator, non-device Apple kind is refused by kind, with its own reason', () => {
  const facts = appleSystemFacts(appleDevice('ios', 'emulator'));
  expect(facts.readClipboard).toEqual({
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'clipboard is supported on Apple simulators and the macOS host.',
  });
  expect(facts.setSetting).toEqual({
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'settings is supported on Apple simulators and the macOS host.',
  });
  expect(facts.readAlert).toEqual({
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'alert is supported on Apple simulators and physical devices.',
  });
});

test('binds the system operations for an admitted cell and none for a refused one', () => {
  const resolve = vi.fn(async () => ({}) as unknown as Interactor);
  const host = { localInteractors: { resolve } };
  const signal = new AbortController().signal;

  const admitted = createAppleSystemOperations({
    host,
    device: appleDevice('ios', 'simulator'),
    signal,
  });
  expect(admitted.readClipboard).toBeTypeOf('function');
  expect(admitted.writeClipboard).toBeTypeOf('function');
  expect(admitted.setSetting).toBeTypeOf('function');
  expect(admitted.readAlert).toBeTypeOf('function');
  expect(admitted.acceptAlert).toBeTypeOf('function');

  const refused = createAppleSystemOperations({
    host,
    device: appleDevice('ios', 'device'),
    signal,
  });
  expect(refused.readClipboard).toBeUndefined();
  expect(refused.writeClipboard).toBeUndefined();
  expect(refused.setSetting).toBeUndefined();
  // The refused cell here is clipboard's and settings' — a physical iOS device, which `alert`
  // deliberately still admits, so its legs stay bound.
  expect(refused.readAlert).toBeTypeOf('function');
  expect(resolve).not.toHaveBeenCalled();
});
