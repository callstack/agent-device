import assert from 'node:assert/strict';
import { test } from 'vitest';
import type {
  GestureCommandInput,
  GestureSemanticInput,
} from '@agent-device/contracts/interaction';
import {
  normalizePublicGesture,
  normalizePublicSwipeMotion,
} from '@agent-device/contracts/interaction';
import { requireGestureSupported } from '../capabilities.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';

const oneFingerPan: GestureSemanticInput = {
  intent: 'pan',
  origin: { x: 100, y: 200 },
  delta: { x: 40, y: -20 },
};
const twoFingerPan: GestureSemanticInput = { ...oneFingerPan, pointerCount: 2 };
const pinch: GestureSemanticInput = { intent: 'pinch', scale: 1.2 };
const fling: GestureSemanticInput = {
  intent: 'fling',
  direction: 'left',
  origin: { x: 100, y: 200 },
};
const drag: GestureCommandInput = {
  intent: 'drag',
  source: 'id="source"',
  destination: 'id="destination"',
};

const device = (fields: Partial<DeviceInfo>): DeviceInfo => ({
  platform: 'android',
  id: 'test-device',
  name: 'Test device',
  kind: 'emulator',
  ...fields,
});

function assertSupported(input: GestureCommandInput, target: DeviceInfo): void {
  assert.doesNotThrow(() => requireGestureSupported(input, target));
}

function assertUnsupported(input: GestureCommandInput, target: DeviceInfo, expected: RegExp): void {
  assert.throws(
    () => requireGestureSupported(input, target),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      expected.test(error.message),
  );
}

test('Android phones and emulators support single- and multi-touch gesture plans', () => {
  for (const kind of ['device', 'emulator'] as const) {
    const target = device({ kind });
    assertSupported(oneFingerPan, target);
    assertSupported(twoFingerPan, target);
    assertSupported(pinch, target);
  }
});

test('target-authored drag is admitted only where adapters preserve every authored phase', () => {
  for (const kind of ['device', 'emulator'] as const) {
    assertSupported(drag, device({ kind, target: 'mobile' }));
  }
  for (const appleOs of ['ios', 'ipados'] as const) {
    for (const kind of ['device', 'simulator'] as const) {
      assertSupported(drag, device({ platform: 'apple', appleOs, kind, target: 'mobile' }));
    }
  }
  assertSupported(drag, device({ platform: 'apple', kind: 'simulator', target: 'mobile' }));

  const inexactBackends = [
    device({ target: 'tv' }),
    device({ platform: 'apple', appleOs: 'tvos', kind: 'simulator', target: 'tv' }),
    device({ platform: 'apple', appleOs: 'macos', kind: 'device', target: 'desktop' }),
    device({ platform: 'apple', appleOs: 'visionos', kind: 'simulator' }),
    device({ platform: 'apple', appleOs: 'watchos', kind: 'simulator' }),
    device({ platform: 'linux', kind: 'device', target: 'desktop' }),
    device({ platform: 'vega', kind: 'device', target: 'tv' }),
    device({ platform: 'web', kind: 'device', target: 'desktop' }),
  ];
  for (const target of inexactBackends) {
    assert.throws(
      () => requireGestureSupported(drag, target),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_OPERATION' &&
        error.details?.gesture === 'drag' &&
        /source hold, timed movement, and destination hold/.test(String(error.details?.hint)),
    );
  }
});

test('iOS and iPadOS simulators support multi-touch while physical devices do not', () => {
  for (const appleOs of ['ios', 'ipados'] as const) {
    const simulator = device({ platform: 'apple', appleOs, kind: 'simulator' });
    const physical = device({ platform: 'apple', appleOs, kind: 'device' });
    assertSupported(oneFingerPan, simulator);
    assertSupported(twoFingerPan, simulator);
    assertSupported(pinch, simulator);
    assertSupported(oneFingerPan, physical);
    assertUnsupported(twoFingerPan, physical, /physical iOS devices/);
    assert.throws(
      () => requireGestureSupported(pinch, physical),
      (error: unknown) =>
        error instanceof AppError && /iOS-simulator only/.test(String(error.details?.hint)),
    );
  }
});

test('TV, spatial, watch, desktop, Linux, and web gesture policy stays explicit', () => {
  const androidTv = device({ target: 'tv' });
  const tvOs = device({ platform: 'apple', appleOs: 'tvos', kind: 'simulator', target: 'tv' });
  const visionOs = device({ platform: 'apple', appleOs: 'visionos', kind: 'simulator' });
  const watchOs = device({ platform: 'apple', appleOs: 'watchos', kind: 'simulator' });
  const macOs = device({ platform: 'apple', appleOs: 'macos', kind: 'device', target: 'desktop' });
  const linux = device({ platform: 'linux', kind: 'device', target: 'desktop' });
  const web = device({ platform: 'web', kind: 'device', target: 'desktop' });

  assertSupported(oneFingerPan, androidTv);
  assertUnsupported(twoFingerPan, androidTv, /Android TV/);
  assert.throws(
    () => requireGestureSupported(twoFingerPan, androidTv),
    (error: unknown) =>
      error instanceof AppError &&
      /Android TV has no touch input/.test(String(error.details?.hint)),
  );
  assertUnsupported(twoFingerPan, tvOs, /tvOS/);
  assertUnsupported(twoFingerPan, visionOs, /visionOS/i);
  assertUnsupported(oneFingerPan, watchOs, /watchos/);
  assertSupported(oneFingerPan, macOs);
  assertUnsupported(twoFingerPan, macOs, /macOS/);
  assertSupported(oneFingerPan, linux);
  assertSupported(
    normalizePublicSwipeMotion({ from: { x: 10, y: 20 }, to: { x: 110, y: 20 } }).gesture,
    linux,
  );
  assertSupported(normalizePublicGesture({ kind: 'swipe', preset: 'left' }).gesture, linux);
  assertUnsupported(fling, linux, /Linux/);
  assertUnsupported(twoFingerPan, linux, /linux/i);
  assertUnsupported(oneFingerPan, web, /web/);
});
