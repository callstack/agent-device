import { bindTestCommandHost } from '@agent-device/test-kit';
import assert from 'node:assert/strict';
import { expect, test } from 'vitest';
import type { AppleOS, DeviceInfo } from '@agent-device/kernel/device';
import { assertRejectsAppError } from '../__tests__/app-error.ts';
import { IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import { withFakeAppleTool } from '../__tests__/fake-apple-tool.ts';
import { platformRuntimeHostFixture } from '../runtime.fixtures.ts';
import { createApplePlatformRuntime } from '../runtime.ts';
import { shakeIosSimulator } from './shake.ts';

bindTestCommandHost();

const simulator = (overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  ...IOS_SIMULATOR,
  target: 'mobile',
  ...overrides,
});

const leaves = {
  ios: simulator(),
  ipados: simulator({ appleOs: 'ipados' }),
  tvos: simulator({ appleOs: 'tvos', target: 'tv' }),
  macos: simulator({ appleOs: 'macos', kind: 'device', target: 'desktop' }),
  visionos: simulator({ appleOs: 'visionos' }),
  watchos: simulator({ appleOs: 'watchos' }),
} satisfies Record<AppleOS, DeviceInfo>;

async function shakeCell(device: DeviceInfo) {
  const binding = await createApplePlatformRuntime(platformRuntimeHostFixture()).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  return { fact: binding.facts.operations.shake, operation: binding.operations.shake };
}

// simctl posts the shake, so only the iPhone and iPad simulator leaves admit and bind it.
test.each(Object.entries(leaves))(
  'classifies the shake fact for the %s leaf',
  async (name, device) => {
    const { fact, operation } = await shakeCell(device);
    if (name === 'ios' || name === 'ipados') {
      expect(fact).toEqual({ available: true });
      expect(operation).toBeTypeOf('function');
      return;
    }
    expect(fact).toMatchObject({ available: false, reason: 'unsupported-platform-leaf' });
    expect(operation).toBeTypeOf('undefined');
  },
);

test('refuses the shake fact on a physical iPhone, which no host control can shake', async () => {
  const { fact, operation } = await shakeCell(simulator({ kind: 'device' }));
  expect(fact).toMatchObject({ available: false, reason: 'unsupported-device-kind' });
  expect(operation).toBeTypeOf('undefined');
});

test('shake posts the simulator shake notification inside the simulator', async () => {
  await withFakeAppleTool(
    () => '',
    async ({ calls, device }) => {
      await shakeIosSimulator(device, undefined);
      assert.deepEqual(calls, [
        ['simctl', 'spawn', 'sim-1', 'notifyutil', '-p', 'com.apple.UIKit.SimulatorShake'],
      ]);
    },
    { device: IOS_SIMULATOR },
  );
});

test('shake fails when simctl cannot reach the simulator', async () => {
  await withFakeAppleTool(
    () => ({ exitCode: 149, stderr: 'Unable to lookup in current state: Shutdown' }),
    async ({ device }) => {
      await assertRejectsAppError(() => shakeIosSimulator(device, undefined), {
        code: 'COMMAND_FAILED',
      });
    },
    { device: IOS_SIMULATOR },
  );
});
