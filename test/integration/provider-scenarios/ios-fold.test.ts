import { formatPortableActionLine, parseReplayScriptDetailed } from '@agent-device/ad-script';
import { recordActionEntry } from '../../../src/daemon/session-action-recorder.ts';
import { assertRpcOk } from './assertions.ts';
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
    const recorded = recordActionEntry(daemon.session()!, {
      command: 'fold',
      positionals: [],
      flags: { keyframes: JSON.stringify(trajectory) },
      result,
    });
    assert.ok(recorded);
    const line = formatPortableActionLine(recorded);
    assert.match(line, /--keyframes/);
    const [parsed] = parseReplayScriptDetailed(line).actions;
    assert.ok(parsed);
    const replayed = assertRpcOk(
      await daemon.callCommand(parsed.command, parsed.positionals ?? [], parsed.flags),
    );
    assert.equal(replayed.hingeAngleDegrees, 100);
    assert.equal(builds, 2);
    assert.equal(tool.calls.filter((call) => call.includes('spawn')).length, 2);
    assert.equal(tool.calls.filter((call) => call.includes('hinge-angle')).length, 4);
  } finally {
    await daemon.close();
  }
});
