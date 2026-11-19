import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { createAndroidSettingsWorld } from './android-world.ts';
import { withProviderScenarioResource } from './harness.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

test('a run whose sweep was skipped still runs a scenario that never compiles a Swift helper', async () => {
  // A skipped sweep names no checkout-local directory, as on a checkout another user owns.
  vi.stubEnv('AGENT_DEVICE_TEST_UNSHARED_DIR', '');

  await withProviderScenarioResource(createAndroidSettingsWorld, async (world) => {
    await world.daemon.client().apps.open({ app: 'settings', ...world.selection });

    assert.ok(world.adbCalls.some((call) => call.includes('com.android.settings')));
  });
});
