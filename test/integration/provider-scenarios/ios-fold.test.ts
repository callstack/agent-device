import { makeIosAppSession } from '../../../src/__tests__/test-utils/session-factories.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import { createProviderScenarioHarness } from './harness.ts';
import { createRecordingAppleToolProvider } from './providers.ts';
import { PROVIDER_SCENARIO_IOS_SIMULATOR } from './fixtures.ts';

test('timed fold keyframes reach simulator HID through the public client and daemon', async () => {
  const trajectory = [
    { atMs: 0, angle: 0 },
    { atMs: 5000, angle: 100 },
  ];
  const ok = { stdout: '', stderr: '', exitCode: 0 };
  let angle = 0;
  const tool = createRecordingAppleToolProvider({
    simctl: async (args, options) => {
      assert.equal(args[0], 'spawn');
      assert.equal(args[1], PROVIDER_SCENARIO_IOS_SIMULATOR.id);
      assert.deepEqual(JSON.parse(args[3]!), trajectory);
      assert.equal(options?.timeoutMs, 15000);
      angle = 100;
      return ok;
    },
    devicectl: async (args) => {
      if (args.includes('hinge-angle')) return { ...ok, stdout: `Angle: ${angle}°`, exitCode: 1 };
      assert.ok(args.includes('displays'));
      const displays = [0, 1].map((displayId) => ({
        name: `LCD-${displayId}`,
        displayId,
        nativeSize: [2007, 2853],
        pointScale: 3,
        type: { integrated: {} },
        active: displayId === 1,
      }));
      fs.writeFileSync(
        args[args.indexOf('--json-output') + 1]!,
        JSON.stringify({ result: { displays } }),
      );
      return ok;
    },
  });
  let builds = 0;
  const daemon = await createProviderScenarioHarness({
    deviceInventoryProvider: async () => [PROVIDER_SCENARIO_IOS_SIMULATOR],
    appleToolProvider: () => ({
      ...tool.provider,
      runCommand: async (command, args) => {
        assert.equal(command, 'xcrun');
        assert.ok(args.includes('clang'));
        builds++;
        return ok;
      },
    }),
  });
  daemon.setSession(
    'default',
    makeIosAppSession('default', { device: PROVIDER_SCENARIO_IOS_SIMULATOR }),
  );
  try {
    const result = await daemon.client().command.fold({
      platform: 'ios',
      udid: PROVIDER_SCENARIO_IOS_SIMULATOR.id,
      keyframes: trajectory,
    });
    assert.equal(result.pose, 'half-open');
    assert.equal(result.hingeAngleDegrees, 100);
    assert.equal(builds, 1);
    assert.equal(tool.calls.filter((call) => call.includes('spawn')).length, 1);
    assert.equal(tool.calls.filter((call) => call.includes('hinge-angle')).length, 2);
  } finally {
    await daemon.close();
  }
});
