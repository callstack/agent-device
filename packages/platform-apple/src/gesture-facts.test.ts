import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createApplePlatformRuntime } from './runtime.ts';
import { platformRuntimeHostFixture } from './runtime.fixtures.ts';

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'apple-fact',
    name: 'Apple',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
    ...overrides,
  };
}

const leaves = {
  ios: appleDevice(),
  ipados: appleDevice({ appleOs: 'ipados' }),
  tvos: appleDevice({ appleOs: 'tvos', target: 'tv' }),
  macos: appleDevice({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
  visionos: appleDevice({ appleOs: 'visionos' }),
  watchos: appleDevice({ appleOs: 'watchos' }),
};

// R52/R53: the gesture-tier and scroll cells the retired `requireGestureSupported` used to
// decide inside the daemon. Each row is one Apple leaf's complete gesture table, so a cell that
// silently widens (or narrows) fails here rather than on a device.
test.each([
  // leaf, plan, directionalFling, multiTouch, drag, viewport, scroll
  ['iOS simulator', leaves.ios, true, true, true, true, true, true],
  [
    'iOS physical',
    appleDevice({ kind: 'device', iosPhysicalDeviceBackend: 'coredevice' }),
    true,
    true,
    false,
    true,
    true,
    true,
  ],
  ['iPadOS simulator', leaves.ipados, true, true, true, true, true, true],
  ['tvOS simulator', leaves.tvos, true, true, false, false, true, true],
  ['macOS host', leaves.macos, true, true, false, false, true, true],
  ['visionOS simulator', leaves.visionos, false, false, false, false, true, true],
  ['watchOS sentinel', leaves.watchos, false, false, false, false, false, true],
])(
  'declares the %s gesture and scroll cells',
  async (_name, device, plan, directionalFling, multiTouch, drag, viewport, scroll) => {
    const facts = await createApplePlatformRuntime(platformRuntimeHostFixture()).inspectFacts(
      device,
    );
    expect(facts.operations.performGesturePlan.available).toBe(plan);
    expect(facts.operations.performDirectionalFlingPlan.available).toBe(directionalFling);
    expect(facts.operations.performMultiTouchGesturePlan.available).toBe(multiTouch);
    expect(facts.operations.performTargetAuthoredDrag.available).toBe(drag);
    expect(facts.operations.gestureViewport.available).toBe(viewport);
    expect(facts.operations.scrollDirection.available).toBe(scroll);
  },
);

test('carries the retired multi-touch hints verbatim on every Apple leaf that refused', async () => {
  const runtime = createApplePlatformRuntime(platformRuntimeHostFixture());
  const physical = await runtime.inspectFacts(appleDevice({ kind: 'device' }));
  expect(physical.operations.performMultiTouchGesturePlan).toEqual({
    available: false,
    reason: 'unsupported-device-kind',
    hint: 'Two-finger gesture synthesis is iOS-simulator only — not available on physical iOS devices.',
  });
  const macos = await runtime.inspectFacts(leaves.macos);
  expect(macos.operations.performMultiTouchGesturePlan).toMatchObject({
    available: false,
    hint: expect.stringContaining('macOS automation has no multi-touch input'),
  });
  expect(macos.operations.performTargetAuthoredDrag).toMatchObject({
    available: false,
    hint: expect.stringContaining('source hold, timed movement, and destination hold'),
  });
  // watchOS was caught by the retired admission's FIRST branch, before the policy that carries
  // the per-OS hints ever ran, so it refuses without one.
  const watchos = await runtime.inspectFacts(leaves.watchos);
  expect(watchos.operations.performGesturePlan).toEqual({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
});

test('binds only the gesture tiers the leaf admitted', async () => {
  const bind = async (device: DeviceInfo) =>
    await createApplePlatformRuntime(platformRuntimeHostFixture()).bind({
      device,
      intent: { kind: 'ordinary' },
      scope: {
        signal: new AbortController().signal,
        diagnostics: { emit: () => {} },
        progress: { report: () => {} },
      },
    });
  const simulator = await bind(leaves.ios);
  expect(simulator.operations.performGesturePlan).toBeTypeOf('function');
  expect(simulator.operations.performMultiTouchGesturePlan).toBeTypeOf('function');
  expect(simulator.operations.scrollDirection).toBeTypeOf('function');
  const physical = await bind(appleDevice({ kind: 'device' }));
  expect(physical.operations.performGesturePlan).toBeTypeOf('function');
  expect(physical.operations.performMultiTouchGesturePlan).toBeUndefined();
});
