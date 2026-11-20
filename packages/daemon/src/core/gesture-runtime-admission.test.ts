import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT } from '@agent-device/contracts/gesture-admission';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import { resolveBoundGestureRuntime } from './gesture-runtime.ts';

const multiTouchInput = { intent: 'pinch', scale: 1.2 } as const;

const heldPanInput = {
  intent: 'pan',
  origin: { x: 100, y: 200 },
  delta: { x: 0, y: 160 },
  durationMs: 500,
  holdMs: 800,
} as const;

const refusalCases = [
  {
    name: 'Android TV',
    device: {
      platform: 'android',
      id: 'android-tv',
      name: 'Android TV',
      kind: 'device',
      target: 'tv',
    },
    fact: {
      available: false,
      reason: 'unsupported-platform-leaf',
      hint: 'Android TV has no touch input — this gesture is supported on Android phones, tablets, iOS, and iPadOS.',
    },
    hint: /Android TV has no touch input/,
    message: 'gesture pinch is not supported on Android TV',
  },
  {
    name: 'tvOS',
    device: {
      platform: 'apple',
      appleOs: 'tvos',
      id: 'tvos-simulator',
      name: 'Apple TV Simulator',
      kind: 'simulator',
      target: 'tv',
    },
    fact: {
      available: false,
      reason: 'unsupported-platform-leaf',
      hint: 'tvOS does not support multi-touch gesture plans.',
    },
    hint: /tvOS/,
    message: 'gesture pinch is not supported on tvOS',
  },
  {
    // The Apple owner admits physical iOS; a provider without the XCTest runner can still refuse.
    name: 'provider-refused physical iOS',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'ios-device',
      name: 'iPhone',
      kind: 'device',
      target: 'mobile',
    },
    fact: {
      available: false,
      reason: 'unsupported-provider-mode',
      hint: 'Two-finger gesture synthesis is not available on iOS devices reached through a WebDriver provider.',
    },
    hint: /WebDriver provider/,
    message: 'gesture pinch is not supported on iOS',
  },
  {
    name: 'provider-refused iPadOS',
    device: {
      platform: 'apple',
      appleOs: 'ipados',
      id: 'ipad-device',
      name: 'iPad',
      kind: 'device',
      target: 'mobile',
    },
    fact: {
      available: false,
      reason: 'unsupported-provider-mode',
      hint: 'Two-finger gesture synthesis is not available on iOS devices reached through a WebDriver provider.',
    },
    hint: /WebDriver provider/,
    message: 'gesture pinch is not supported on iPadOS',
  },
] as const;

test.each(refusalCases)(
  '$name preserves multi-touch admission details without binding',
  async ({ device, fact, hint, message }) => {
    const target = device as DeviceInfo;
    const owner = localRuntimeOwner(target.platform);
    const base = createUnavailableRuntimeFactsForTest(target, owner);
    const inspectFacts = vi.fn(async () => ({
      ...base,
      operations: {
        ...base.operations,
        captureSnapshot: { available: true } as const,
        performMultiTouchGesturePlan: fact,
      },
    }));
    const bindDevice = vi.fn(async () => {
      throw new Error('unavailable multi-touch must be refused before bind');
    });

    const resolved = await resolveBoundGestureRuntime({
      device: target,
      input: multiTouchInput,
      inspectFacts,
      bindDevice,
      platformServices: daemonPlatformServicesFixture(),
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.response.error.code).toBe('UNSUPPORTED_OPERATION');
      expect(resolved.response.error.message).toBe(message);
      expect(resolved.response.error.hint).toMatch(hint);
    }
    expect(inspectFacts).toHaveBeenCalledOnce();
    expect(bindDevice).not.toHaveBeenCalled();
  },
);

// Endpoint-only plan lowering (Linux, macOS, tvOS, HarmonyOS) drops the intermediate hold samples,
// so a held pan is admitted through the target-authored-drag tier and refused before dispatch.
const heldPanRefusalCases = [
  {
    name: 'Linux desktop',
    device: {
      platform: 'linux',
      id: 'linux-desktop',
      name: 'Linux Desktop',
      kind: 'device',
      target: 'desktop',
    },
    message: 'gesture pan is not supported on linux',
  },
  {
    name: 'macOS desktop',
    device: {
      platform: 'apple',
      appleOs: 'macos',
      id: 'mac',
      name: 'Mac',
      kind: 'device',
      target: 'desktop',
    },
    message: 'gesture pan is not supported on macos',
  },
] as const;

test.each(heldPanRefusalCases)(
  '$name refuses a held pan with UNSUPPORTED_OPERATION and the drag hint before binding',
  async ({ device, message }) => {
    const target = device as DeviceInfo;
    const owner = localRuntimeOwner(target.platform);
    const base = createUnavailableRuntimeFactsForTest(target, owner);
    const inspectFacts = vi.fn(async () => ({
      ...base,
      operations: {
        ...base.operations,
        captureSnapshot: { available: true } as const,
        performTargetAuthoredDrag: {
          available: false,
          reason: 'unsupported-platform-leaf',
          hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
        } as const,
      },
    }));
    const bindDevice = vi.fn(async () => {
      throw new Error('unavailable drag tier must be refused before bind');
    });

    const resolved = await resolveBoundGestureRuntime({
      device: target,
      input: heldPanInput,
      inspectFacts,
      bindDevice,
      platformServices: daemonPlatformServicesFixture(),
    });

    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.response.error.code).toBe('UNSUPPORTED_OPERATION');
      expect(resolved.response.error.message).toBe(message);
      expect(resolved.response.error.hint).toMatch(/preserves source hold/);
    }
    expect(inspectFacts).toHaveBeenCalledOnce();
    expect(bindDevice).not.toHaveBeenCalled();
  },
);

// On an endpoint-only backend (plan cell available, drag cell not) an unheld pan is still admitted
// through the plan tier and binds, while a held pan is refused — the two directions of the routing.
test('on Linux an unheld pan still goes to the plan tier and binds; a held pan is refused', async () => {
  const linuxDesktop = {
    platform: 'linux',
    id: 'linux-desktop',
    name: 'Linux Desktop',
    kind: 'device',
    target: 'desktop',
  } as const satisfies DeviceInfo;
  const owner = localRuntimeOwner(linuxDesktop.platform);
  const base = createUnavailableRuntimeFactsForTest(linuxDesktop, owner);
  const inspectFacts = vi.fn(async () => ({
    ...base,
    operations: {
      ...base.operations,
      captureSnapshot: { available: true } as const,
      performGesturePlan: { available: true } as const,
      performTargetAuthoredDrag: {
        available: false,
        reason: 'unsupported-platform-leaf',
        hint: TARGET_AUTHORED_DRAG_UNSUPPORTED_HINT,
      } as const,
    },
  }));
  const bindDevice = vi.fn(async () => ({ operations: {} }) as never);

  const unheld = await resolveBoundGestureRuntime({
    device: linuxDesktop,
    input: { intent: 'pan', origin: { x: 100, y: 200 }, delta: { x: 0, y: 160 }, durationMs: 500 },
    inspectFacts,
    bindDevice,
    platformServices: daemonPlatformServicesFixture(),
  });
  expect(unheld.ok).toBe(true);
  expect(bindDevice).toHaveBeenCalledOnce();

  bindDevice.mockClear();
  const held = await resolveBoundGestureRuntime({
    device: linuxDesktop,
    input: heldPanInput,
    inspectFacts,
    bindDevice,
    platformServices: daemonPlatformServicesFixture(),
  });
  expect(held.ok).toBe(false);
  if (!held.ok) {
    expect(held.response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(held.response.error.message).toBe('gesture pan is not supported on linux');
    expect(held.response.error.hint).toMatch(/preserves source hold/);
  }
  expect(bindDevice).not.toHaveBeenCalled();
});
