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
      hint: 'Android TV has no touch input — this gesture is supported on Android phones, tablets, and the iOS simulator only.',
    },
    hint: /Android TV has no touch input/,
  },
  {
    name: 'physical iOS',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'iphone-device',
      name: 'iPhone',
      kind: 'device',
      target: 'mobile',
    },
    fact: {
      available: false,
      reason: 'unsupported-device-kind',
      hint: 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.',
    },
    hint: /physical iOS devices/,
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
  },
] as const;

test.each(refusalCases)(
  '$name preserves multi-touch admission details without binding',
  async ({ device, fact, hint }) => {
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
      expect(resolved.response.error.hint).toMatch(hint);
    }
    expect(inspectFacts).toHaveBeenCalledOnce();
    expect(bindDevice).not.toHaveBeenCalled();
  },
);
