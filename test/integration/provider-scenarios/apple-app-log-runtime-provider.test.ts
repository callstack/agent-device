import assert from 'node:assert/strict';
import { test } from 'vitest';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider } from './providers.ts';

test('provider-inventory Apple logs doctor stays on the scoped Apple tool provider', async () => {
  const appleTool = createRecordingAppleToolProvider({
    simctl: async (args) => {
      assert.deepEqual(args, ['help']);
      return { stdout: 'simctl help', stderr: '', exitCode: 0 };
    },
  });
  const daemon = await createProviderScenarioHarness({
    platformRuntime: true,
    appleToolProvider: () => appleTool.provider,
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
  });
  daemon.setSession('default', {
    name: 'default',
    device: PROVIDER_SCENARIO_IOS_SIMULATOR,
    appBundleId: 'com.example.app',
    createdAt: Date.now(),
    actions: [],
  });

  try {
    const selection = {
      platform: 'ios' as const,
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
    };
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
