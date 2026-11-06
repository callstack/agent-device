import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { openIosApp } from '../app-launch.ts';
import { withFakeAppleTool } from '../../__tests__/fake-apple-tool.ts';
import {
  IOS_TEST_DEVICE,
  IOS_TEST_SIMULATOR,
  MACOS_TEST_DEVICE,
} from './apple-core-stub-helpers.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('@agent-device/host-kit/diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/diagnostics')>()),
  emitDiagnostic: vi.fn(),
}));
vi.mock('../simulator.ts', () => ({ ensureBootedSimulator: vi.fn() }));
import { ensureBootedSimulator } from '../simulator.ts';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ensureBootedSimulator).mockResolvedValue();
});

const preferenceArgs = [
  'defaults',
  'write',
  'com.apple.Accessibility',
  'ApplicationAccessibilityEnabled',
  '-bool',
  'YES',
];

for (const app of ['com.example.app', 'myapp://home']) {
  test(`prepares accessibility after boot and before ${app}, on every open in a custom set`, async () => {
    const device = { ...IOS_TEST_SIMULATOR, simulatorSetPath: '/tmp/ax-test-set' };
    let booted = false;
    const writeBootStates: boolean[] = [];
    vi.mocked(ensureBootedSimulator).mockImplementation(async () => {
      booted = true;
    });
    await withFakeAppleTool(
      (args) => {
        if (args.includes('defaults')) writeBootStates.push(booted);
        return '';
      },
      async ({ calls }) => {
        await openIosApp(device, app, {
          appBundleId: 'com.example.app',
          terminateRunningApp: true,
        });
        await openIosApp(device, app, { appBundleId: 'com.example.app' });
        assert.deepEqual(writeBootStates, [true, true]);
        const writes = calls.filter((args) => args.includes('defaults'));
        assert.deepEqual(
          writes,
          Array.from({ length: 2 }, () => [
            'simctl',
            '--set',
            '/tmp/ax-test-set',
            'spawn',
            device.id,
            ...preferenceArgs,
          ]),
        );
        for (const [index, args] of calls.entries()) {
          if (args.includes('launch') || args.includes('openurl'))
            assert.ok(calls[index - 1]?.includes('defaults'));
        }
        if (app === 'com.example.app') assert.ok(calls[1]?.includes('--terminate-running-process'));
      },
    );
  });
}

test('preparation failure preserves app launch and emits a diagnostic', async () => {
  const { emitDiagnostic } = await import('@agent-device/host-kit/diagnostics');
  const diagnostic = vi.mocked(emitDiagnostic);
  await withFakeAppleTool(
    (args) => (args.includes('defaults') ? { exitCode: 1, stderr: 'denied' } : ''),
    async ({ calls }) => {
      await openIosApp(IOS_TEST_SIMULATOR, 'com.example.app', { appBundleId: 'com.example.app' });
      assert.ok(calls.at(-1)?.includes('launch'));
      assert.equal(calls.filter((args) => args.includes('defaults')).length, 1);
    },
  );
  assert.ok(
    diagnostic.mock.calls.some(
      ([event]) => event.phase === 'ios_simulator_accessibility_prepare_failed',
    ),
  );
});

for (const device of [
  IOS_TEST_DEVICE,
  MACOS_TEST_DEVICE,
  { ...IOS_TEST_SIMULATOR, appleOs: 'tvos' },
  { ...IOS_TEST_SIMULATOR, appleOs: 'visionos' },
] as DeviceInfo[]) {
  test(`does not write accessibility for ${device.kind}/${device.appleOs}`, async () => {
    await withFakeAppleTool(
      () => '',
      async ({ calls }) => {
        await openIosApp(device, 'com.example.app', { appBundleId: 'com.example.app' });
        assert.equal(
          calls.some((args) => args.includes('defaults')),
          false,
        );
      },
    );
  });
}

test('teardown preparation does not boot a stopped simulator', async () => {
  const { prepareIosSimulatorAccessibility } = await import('../ios-simulator-accessibility.ts');
  await withFakeAppleTool(
    () => ({ exitCode: 1, stderr: 'device is shutdown' }),
    async ({ calls }) => {
      await prepareIosSimulatorAccessibility({ ...IOS_TEST_SIMULATOR, booted: false });
      assert.equal(vi.mocked(ensureBootedSimulator).mock.calls.length, 0);
      assert.deepEqual(calls, [['simctl', 'spawn', IOS_TEST_SIMULATOR.id, ...preferenceArgs]]);
    },
  );
});

test('the teardown writer rejects on failure so runner cleanup can report it', async () => {
  const { enableIosSimulatorAppAccessibility } = await import('../ios-simulator-accessibility.ts');
  await withFakeAppleTool(
    () => {
      throw new Error('defaults unavailable');
    },
    async () => {
      await assert.rejects(
        enableIosSimulatorAppAccessibility(IOS_TEST_SIMULATOR),
        /defaults unavailable/,
      );
    },
  );
});
