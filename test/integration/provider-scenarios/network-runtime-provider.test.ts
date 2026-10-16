import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider, simctlListDevicesResult } from './providers.ts';

test('iOS simulator network recovery stays on the request-scoped Apple tool provider', async () => {
  const appleTool = createRecordingAppleToolProvider({
    simctl: async (args) => {
      const devices = simctlListDevicesResult(args, 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', [
        { name: 'iPhone 15', udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id },
      ]);
      if (devices) return devices;
      if (args.join(' ') === 'listapps sim-1') {
        return {
          stdout: '{"com.example.demo":{"CFBundleDisplayName":"Demo"}}',
          stderr: '',
          exitCode: 0,
        };
      }
      if (args[0] === 'launch') return { stdout: '', stderr: '', exitCode: 0 };
      assert.deepEqual(args.slice(0, 4), ['spawn', 'sim-1', 'log', 'show']);
      return {
        stdout: '2026-08-10T10:00:00Z GET https://provider-recovery.example.test status=200\n',
        stderr: '',
        exitCode: 0,
      };
    },
  });
  const daemon = await createProviderScenarioHarness({
    platformRuntime: true,
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
  });
  try {
    await daemon.client().apps.open({
      app: 'com.example.demo',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });
    const result = await daemon.client().observability.network({
      action: 'dump',
      limit: 5,
      include: 'summary',
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    });

    assert.equal(result.backend, 'ios-simulator');
    const entries = Array.isArray(result.entries) ? result.entries : [];
    assert.equal(
      (entries[0] as Record<string, unknown> | undefined)?.url,
      'https://provider-recovery.example.test',
    );
    assert.ok(
      appleTool.calls.some(
        (call) =>
          call[0] === 'simctl' &&
          call[1] === 'spawn' &&
          call.includes(PROVIDER_SCENARIO_IOS_SIMULATOR.id),
      ),
      JSON.stringify(appleTool.calls),
    );
  } finally {
    await daemon.close();
  }
});
