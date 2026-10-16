import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider, simctlListDevicesResult } from './providers.ts';

test('provider-inventory Apple logs doctor stays on the scoped Apple tool provider', async () => {
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
      assert.deepEqual(args, ['help']);
      return { stdout: 'simctl help', stderr: '', exitCode: 0 };
    },
  });
  const daemon = await createProviderScenarioHarness({
    platformRuntime: true,
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
  });
  try {
    const selection = {
      platform: 'ios' as const,
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    };
    await daemon.client().apps.open({ app: 'com.example.demo', ...selection });
    const result = await daemon.client().observability.logs({
      action: 'doctor',
      ...selection,
    });
    assert.equal((result.checks as { simctlAvailable?: boolean }).simctlAvailable, true);
    assert.ok(
      appleTool.calls.some((call) => call[0] === 'simctl' && call[1] === 'help'),
      JSON.stringify(appleTool.calls),
    );
  } finally {
    await daemon.close();
  }
});
