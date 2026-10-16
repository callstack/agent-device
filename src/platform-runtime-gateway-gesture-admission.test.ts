import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test } from 'vitest';
import { createPlatformRuntimeGateway } from './platform-runtime.ts';

const gateway = createPlatformRuntimeGateway({
  resolveSessionArtifacts: () => ({
    outputPath: '/sessions/gesture-admission/app.log',
    pidPath: '/sessions/gesture-admission/app-log.pid',
  }),
  sessionsDir: '/sessions',
});

const device = (fields: Partial<DeviceInfo>): DeviceInfo => ({
  platform: 'android',
  id: 'test-device',
  name: 'Test device',
  kind: 'emulator',
  ...fields,
});

test('Android phones and emulators admit single- and multi-touch gesture plans', async () => {
  for (const kind of ['device', 'emulator'] as const) {
    const facts = await gateway.inspectFacts(device({ kind }));
    expect(facts.operations.performGesturePlan.available).toBe(true);
    expect(facts.operations.performMultiTouchGesturePlan.available).toBe(true);
  }
});

test('target-authored drag is admitted only where adapters preserve every authored phase', async () => {
  const supported = [
    device({ kind: 'device', target: 'mobile' }),
    device({ platform: 'apple', appleOs: 'ios', kind: 'simulator', target: 'mobile' }),
    device({ platform: 'apple', appleOs: 'ipados', kind: 'simulator', target: 'mobile' }),
    device({ platform: 'apple', kind: 'simulator', target: 'mobile' }),
  ];
  for (const target of supported) {
    expect(
      (await gateway.inspectFacts(target)).operations.performTargetAuthoredDrag.available,
      `${target.platform}/${target.appleOs ?? ''}/${target.kind}/${target.target ?? ''}`,
    ).toBe(true);
  }

  const inexact = [
    device({ target: 'tv' }),
    device({ platform: 'apple', appleOs: 'tvos', kind: 'simulator', target: 'tv' }),
    device({ platform: 'apple', appleOs: 'macos', kind: 'device', target: 'desktop' }),
    device({ platform: 'apple', appleOs: 'visionos', kind: 'simulator' }),
    device({ platform: 'apple', appleOs: 'watchos', kind: 'simulator' }),
    device({ platform: 'linux', kind: 'device', target: 'desktop' }),
    device({ platform: 'vega', kind: 'device', target: 'tv' }),
    device({ platform: 'web', kind: 'device', target: 'desktop' }),
  ];
  for (const target of inexact) {
    const fact = (await gateway.inspectFacts(target)).operations.performTargetAuthoredDrag;
    expect(fact.available).toBe(false);
    if (!fact.available)
      expect(fact.hint).toMatch(/source hold, timed movement, and destination hold/);
  }
});

test('iOS and iPadOS simulators admit multi-touch while physical devices do not', async () => {
  for (const appleOs of ['ios', 'ipados'] as const) {
    const simulator = await gateway.inspectFacts(
      device({ platform: 'apple', appleOs, kind: 'simulator' }),
    );
    const physical = await gateway.inspectFacts(
      device({ platform: 'apple', appleOs, kind: 'device' }),
    );
    expect(simulator.operations.performGesturePlan.available).toBe(true);
    expect(simulator.operations.performMultiTouchGesturePlan.available).toBe(true);
    expect(physical.operations.performGesturePlan.available).toBe(true);
    expect(physical.operations.performMultiTouchGesturePlan).toMatchObject({
      available: false,
      hint: expect.stringMatching(/iOS-simulator only/),
    });
  }
});

test('TV, spatial, watch, desktop, Linux, and web gesture policy stays explicit', async () => {
  const androidTv = await gateway.inspectFacts(device({ target: 'tv' }));
  const tvOs = await gateway.inspectFacts(
    device({ platform: 'apple', appleOs: 'tvos', kind: 'simulator', target: 'tv' }),
  );
  const visionOs = await gateway.inspectFacts(
    device({ platform: 'apple', appleOs: 'visionos', kind: 'simulator' }),
  );
  const watchOs = await gateway.inspectFacts(
    device({ platform: 'apple', appleOs: 'watchos', kind: 'simulator' }),
  );
  const macOs = await gateway.inspectFacts(
    device({ platform: 'apple', appleOs: 'macos', kind: 'device', target: 'desktop' }),
  );
  const linux = await gateway.inspectFacts(
    device({ platform: 'linux', kind: 'device', target: 'desktop' }),
  );
  const web = await gateway.inspectFacts(
    device({ platform: 'web', kind: 'device', target: 'desktop' }),
  );

  expect(androidTv.operations.performGesturePlan.available).toBe(true);
  expect(androidTv.operations.performMultiTouchGesturePlan).toMatchObject({
    available: false,
    hint: expect.stringMatching(/Android TV has no touch input/),
  });
  expect(tvOs.operations.performMultiTouchGesturePlan.available).toBe(false);
  expect(visionOs.operations.performMultiTouchGesturePlan.available).toBe(false);
  expect(watchOs.operations.performGesturePlan.available).toBe(false);
  expect(macOs.operations.performGesturePlan.available).toBe(true);
  expect(macOs.operations.performMultiTouchGesturePlan.available).toBe(false);
  expect(linux.operations.performGesturePlan.available).toBe(true);
  expect(linux.operations.performDirectionalFlingPlan.available).toBe(false);
  expect(linux.operations.performMultiTouchGesturePlan.available).toBe(false);
  expect(web.operations.performGesturePlan.available).toBe(false);
});
