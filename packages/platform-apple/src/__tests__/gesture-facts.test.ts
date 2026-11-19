import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { appleGestureAndScrollFacts } from '../gesture-facts.ts';
import {
  IOS_DEVICE,
  IOS_SIMULATOR,
  IPADOS_SIMULATOR,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
} from './device-fixtures.ts';

// `scroll refresh` admits exactly where the Apple runtime declares a touch scroll surface:
// iOS and iPadOS simulators and devices. watchOS/tvOS/visionOS and the macOS desktop refuse it.
test.each([
  ['iOS simulator', IOS_SIMULATOR, true],
  ['iPadOS simulator', IPADOS_SIMULATOR, true],
  ['iOS device', IOS_DEVICE, true],
  ['tvOS simulator', TVOS_SIMULATOR, false],
  ['macOS desktop', MACOS_DEVICE, false],
  ['watchOS simulator', { ...IOS_SIMULATOR, appleOs: 'watchos' } as DeviceInfo, false],
])('declares the touch-scroll surface on the Apple %s', (_name, device, expected) => {
  const facts = appleGestureAndScrollFacts(device);
  expect(facts.touchScrollSurface.available).toBe(expected);
  if (!expected) {
    expect(facts.touchScrollSurface).toMatchObject({
      reason: 'unsupported-platform-leaf',
      hint: expect.stringContaining('touch scroll surface'),
    });
  }
});
