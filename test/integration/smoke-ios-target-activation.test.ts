import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

/**
 * Live lane for #2682: an off-app handoff followed by `screenshot` then `snapshot` must not let the
 * second capture answer as if nothing had moved. The disclosure can only come from the runner that
 * actually activated the bound app, so this drives the real runner on a real simulator — a mocked
 * runner response proves the decoder, not the fact.
 *
 * Requires the same environment as the iOS simulator E2E lane plus a fixture app already installed:
 *   AGENT_DEVICE_IOS_E2E=1 AGENT_DEVICE_FIXTURE_APP_ID=... AGENT_DEVICE_IOS_UDID=...
 *   node --test test/integration/smoke-ios-target-activation.test.ts
 */

const enabled = process.env.AGENT_DEVICE_IOS_E2E === '1';
const appId = process.env.AGENT_DEVICE_FIXTURE_APP_ID ?? '';
const udid = process.env.AGENT_DEVICE_IOS_UDID ?? '';
const stateDir = process.env.AGENT_DEVICE_STATE_DIR ?? '';
const session = process.env.AGENT_DEVICE_IOS_E2E_SESSION ?? 'smoke-target-activation';

test(
  'live iOS runner discloses a foreground repair on the command that paid for it',
  {
    skip:
      enabled && appId && udid ? false : 'Set AGENT_DEVICE_IOS_E2E=1 with fixture app id and UDID.',
  },
  () => {
    const cli = ['bin/agent-device.mjs'];
    const selector = ['--platform', 'ios', '--udid', udid, '--session', session];
    if (stateDir) selector.push('--state-dir', stateDir);
    const run = (args: string[]) => {
      const result = spawnSync('node', [...cli, ...args, ...selector], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
      return result.stdout;
    };

    try {
      run(['open', appId]);
      // Screenshot is a lifecycle command: it serves whatever is foreground without touching the
      // bound app, so it is the observation the repair would otherwise contradict.
      run(['screenshot', '--out', '/tmp/agent-device-2682-before.png']);
      // Hand off to another app the same way an in-app external link does: LaunchServices brings
      // MobileSafari forward while the session stays bound to the fixture app.
      const handoff = spawnSync('xcrun', ['simctl', 'openurl', udid, 'https://example.com'], {
        encoding: 'utf8',
      });
      assert.equal(handoff.status, 0, `simctl openurl failed: ${handoff.stderr}`);
      spawnSync('sleep', ['6']);
      run(['screenshot', '--out', '/tmp/agent-device-2682-foreign.png']);

      const snapshot = run(['snapshot', '-i']);
      assert.match(
        snapshot,
        /The session app was not foreground when this command arrived/,
        `no foreground disclosure after an off-app handoff:\n${snapshot.slice(0, 400)}`,
      );
      assert.match(snapshot, /prior state running(Background|BackgroundSuspended)/);
      assert.match(snapshot, /reason (stale_target|bundle_changed|missing_after_wait)/);

      // The repair is a fact about one command, not a property of the session: with the app already
      // foreground again, the next capture must say nothing.
      const settled = run(['snapshot', '-i']);
      assert.equal(
        settled.includes('The session app was not foreground'),
        false,
        `second capture re-disclosed a repair it did not perform:\n${settled.slice(0, 400)}`,
      );
    } finally {
      run(['close']);
    }
  },
);
