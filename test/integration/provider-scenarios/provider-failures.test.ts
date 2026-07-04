import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { AndroidAdbProvider } from '../../../src/platforms/android/adb-executor.ts';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration normalizes provider failures through the request path', async () => {
  const adbCalls: string[][] = [];
  const adbProvider: AndroidAdbProvider = {
    exec: async (args) => {
      adbCalls.push([...args]);
      if (args.join(' ') === 'shell getprop sys.boot_completed') {
        return { stdout: '1\n', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: 'uiautomator unavailable', exitCode: 1 };
    },
  };
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        androidAdbProvider: () => adbProvider,
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      const response = await daemon.callCommand('snapshot', [], {
        platform: 'android',
        serial: PROVIDER_SCENARIO_ANDROID.id,
        snapshotInteractiveOnly: true,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json?.error?.data?.code, 'COMMAND_FAILED');
      assert.match(
        response.json?.error?.message ?? '',
        /uiautomator dump did not return XML: uiautomator unavailable/i,
      );
      assert.equal(typeof response.json?.error?.data?.diagnosticId, 'string');
      assert.ok(
        adbCalls.some((call) => call.join(' ') === 'exec-out uiautomator dump /dev/tty'),
        JSON.stringify(adbCalls),
      );
    },
  );
});
