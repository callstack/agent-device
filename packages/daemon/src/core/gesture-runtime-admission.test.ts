import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createUnavailableRuntimeFactsForTest } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { daemonPlatformServicesFixture } from '../__tests__/support/platform-services-fixture.ts';
import { resolveBoundGestureRuntime } from './gesture-runtime.ts';

const multiTouchInput = { intent: 'pinch', scale: 1.2 } as const;

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
