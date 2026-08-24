import { expect, test } from 'vitest';
import type {
  GestureCommandInput,
  GestureSemanticInput,
} from '@agent-device/contracts/gesture-plan-types';
import {
  normalizePublicGesture,
  normalizePublicSwipeMotion,
} from '@agent-device/contracts/gesture-normalization';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createPlatformRuntimeGateway } from '../../platform-runtime.ts';
import { createRequestRuntimeBindings } from '../request-runtime-binding.ts';
import { resolveBoundGestureRuntime } from '../gesture-runtime.ts';

/**
 * The parity artifact for R42/R44 (ADR 0019 §6).
 *
 * This is the retired `requireGestureSupported` suite's device matrix, re-pointed at what
 * replaced it: the REAL composed runtime gateway's owner facts, admitted through the real daemon
 * gesture admission. Every assertion below — admitted or refused, message and hint — is the
 * behavior `main` produced before the cutover, so a fact cell that drifts from the admission it
 * restates fails here rather than on a device.
 */
const gateway = createPlatformRuntimeGateway({
  resolveSessionArtifacts: () => ({
    outputPath: '/sessions/parity/app.log',
    pidPath: '/sessions/parity/app-log.pid',
  }),
  sessionsDir: '/sessions',
});

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

/** The production binding seam, so admission runs against the real inspect-then-bind path. */
async function admit(input: GestureCommandInput, target: DeviceInfo) {
  const bindings = createRequestRuntimeBindings({
    gateway,
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    admitDeviceClaim: async () => {},
  });
  try {
    return await resolveBoundGestureRuntime({
      device: target,
      input,
      inspectFacts: bindings.inspectFacts,
      bindDevice: bindings.bindDevice,
    });
  } finally {
    await bindings[Symbol.asyncDispose]();
  }
}

async function expectAdmitted(input: GestureCommandInput, target: DeviceInfo): Promise<void> {
  const resolved = await admit(input, target);
  expect(resolved.ok, `${input.intent} should be admitted on ${target.platform}`).toBe(true);
}

async function expectRefused(
  input: GestureCommandInput,
  target: DeviceInfo,
  message: RegExp,
  hint?: RegExp,
): Promise<void> {
  const resolved = await admit(input, target);
  expect(resolved.ok).toBe(false);
  if (resolved.ok) return;
  expect(resolved.response.error.code).toBe('UNSUPPORTED_OPERATION');
  expect(resolved.response.error.message).toMatch(message);
  if (hint) expect(String(resolved.response.error.hint)).toMatch(hint);
}

test('Android phones and emulators admit single- and multi-touch gesture plans', async () => {
  for (const kind of ['device', 'emulator'] as const) {
    const target = device({ kind });
    await expectAdmitted(oneFingerPan, target);
    await expectAdmitted(twoFingerPan, target);
    await expectAdmitted(pinch, target);
  }
});

test('target-authored drag is admitted only where adapters preserve every authored phase', async () => {
  for (const kind of ['device', 'emulator'] as const) {
    await expectAdmitted(drag, device({ kind, target: 'mobile' }));
  }
  for (const appleOs of ['ios', 'ipados'] as const) {
    for (const kind of ['device', 'simulator'] as const) {
      await expectAdmitted(drag, device({ platform: 'apple', appleOs, kind, target: 'mobile' }));
    }
  }
  await expectAdmitted(drag, device({ platform: 'apple', kind: 'simulator', target: 'mobile' }));

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
    await expectRefused(
      drag,
      target,
      /^gesture drag is not supported on /,
      /source hold, timed movement, and destination hold/,
    );
  }
});

test('iOS and iPadOS simulators admit multi-touch while physical devices do not', async () => {
  for (const appleOs of ['ios', 'ipados'] as const) {
    const simulator = device({ platform: 'apple', appleOs, kind: 'simulator' });
    const physical = device({ platform: 'apple', appleOs, kind: 'device' });
    await expectAdmitted(oneFingerPan, simulator);
    await expectAdmitted(twoFingerPan, simulator);
    await expectAdmitted(pinch, simulator);
    await expectAdmitted(oneFingerPan, physical);
    await expectRefused(twoFingerPan, physical, /physical iOS devices/);
    await expectRefused(pinch, physical, /physical iOS devices/, /iOS-simulator only/);
  }
});

test('TV, spatial, watch, desktop, Linux, and web gesture policy stays explicit', async () => {
  const androidTv = device({ target: 'tv' });
  const tvOs = device({ platform: 'apple', appleOs: 'tvos', kind: 'simulator', target: 'tv' });
  const visionOs = device({ platform: 'apple', appleOs: 'visionos', kind: 'simulator' });
  const watchOs = device({ platform: 'apple', appleOs: 'watchos', kind: 'simulator' });
  const macOs = device({ platform: 'apple', appleOs: 'macos', kind: 'device', target: 'desktop' });
  const linux = device({ platform: 'linux', kind: 'device', target: 'desktop' });
  const web = device({ platform: 'web', kind: 'device', target: 'desktop' });

  await expectAdmitted(oneFingerPan, androidTv);
  await expectRefused(twoFingerPan, androidTv, /Android TV/, /Android TV has no touch input/);
  await expectRefused(twoFingerPan, tvOs, /tvOS/);
  await expectRefused(twoFingerPan, visionOs, /visionOS/);
  await expectRefused(oneFingerPan, watchOs, /watchos/);
  await expectAdmitted(oneFingerPan, macOs);
  await expectRefused(twoFingerPan, macOs, /macOS/);
  await expectAdmitted(oneFingerPan, linux);
  await expectAdmitted(
    normalizePublicSwipeMotion({ from: { x: 10, y: 20 }, to: { x: 110, y: 20 } }).gesture,
    linux,
  );
  await expectAdmitted(normalizePublicGesture({ kind: 'swipe', preset: 'left' }).gesture, linux);
  await expectRefused(fling, linux, /gesture fling is not supported on Linux/);
  await expectRefused(twoFingerPan, linux, /linux/);
  await expectRefused(oneFingerPan, web, /web/);
});
