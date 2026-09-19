import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { iosTargetActivationDisclosure } from '@agent-device/contracts/ios-target-activation';
import { runCmd } from '@agent-device/host-kit/command';
import {
  cleanupSession,
  createContext,
  runStep,
  type LiveContext,
} from './ios-simulator-e2e/live-harness.ts';

/**
 * Live lane for #2682: an off-app handoff followed by `screenshot` then `snapshot` must not let the
 * second capture answer as if nothing had moved. The disclosure can only come from the runner that
 * actually activated the bound app, so this drives the real runner on a real simulator — a mocked
 * runner response proves the decoder, not the fact.
 *
 * Runs on the same lanes as the iOS simulator fixture E2E (`smoke` and `full` tiers) and needs the
 * same environment: `AGENT_DEVICE_IOS_E2E=1`, `AGENT_DEVICE_IOS_E2E_TIER`, `AGENT_DEVICE_FIXTURE_APP_PATH`
 * and `AGENT_DEVICE_FIXTURE_APP_ID`, and `AGENT_DEVICE_IOS_UDID`. Those lanes fetch the fixture with
 * `install: 'false'`, so this lane installs it through the public CLI like the other fixture lanes do.
 */

const enabled = process.env.AGENT_DEVICE_IOS_E2E === '1';
// Settings, not a web link: `simctl openurl https://…` hands off through Safari, and on a CI
// simulator that handoff can complete without Safari ever taking the foreground, which leaves this
// lane waiting for a repair that was never owed. `simctl launch com.apple.Preferences` is the
// handoff the iOS replays already rely on for the same effect.
const HANDOFF_BUNDLE_ID = 'com.apple.Preferences';
const HANDOFF_DEADLINE_MS = 90_000;
const HANDOFF_POLL_MS = 2_000;

test(
  'live iOS runner discloses a foreground repair on the command that paid for it',
  { skip: enabled ? false : 'Set AGENT_DEVICE_IOS_E2E=1 to run the live iOS lanes.' },
  async () => {
    const context = createContext();
    try {
      await runStep(context, 'install fixture app', ['install', context.appPath]);
      await runStep(context, 'open fixture app', ['open', context.appId]);

      // Screenshot is a lifecycle command: it serves whatever is foreground without touching the
      // bound app, so it is the observation the repair would otherwise contradict.
      const before = path.join(context.artifactDir, 'target-activation-before.png');
      await runStep(context, 'screenshot session app', ['screenshot', '--out', before]);
      assert.ok(await exists(before), `screenshot wrote no artifact: ${before}`);

      const foreign = path.join(context.artifactDir, 'target-activation-foreign.png');

      // Hand off to an app the session is not bound to. Settings comes forward and the fixture app
      // goes background, which is the state the next capture has to repair.
      const handoff = await runCmd('xcrun', ['simctl', 'launch', context.udid, HANDOFF_BUNDLE_ID]);
      assert.equal(
        handoff.exitCode,
        0,
        `simctl launch ${HANDOFF_BUNDLE_ID} failed: ${handoff.stderr}`,
      );
      await runStep(context, 'screenshot after handoff', ['screenshot', '--out', foreign]);
      assert.ok(await exists(foreign), `post-handoff screenshot wrote no artifact: ${foreign}`);
      // A screenshot identical to the pre-handoff one means nothing moved to the foreground and the
      // lane would be waiting for a repair the device is not obliged to report.
      assert.notEqual(
        await checksum(before),
        await checksum(foreign),
        'the screen did not change after launching Settings: no handoff to repair',
      );

      // Poll instead of sleeping a fixed window: the disclosure must arrive on the command that
      // paid for the repair, and a lane that never sees one is the regression this asserts against.
      const repaired = await captureUntilDisclosed(context);
      const fact = repaired.json!.data.targetActivation;
      assert.ok(
        typeof fact.reason === 'string' && fact.reason.length > 0,
        `disclosure carried no reason: ${JSON.stringify(fact)}`,
      );
      assert.match(
        String(fact.priorState),
        /^running(Background|BackgroundSuspended)$|^notRunning$|^unknown$/,
        `prior state claims the repair's outcome, not its starting point: ${fact.priorState}`,
      );
      const warnings: unknown[] = repaired.json!.data.warnings ?? [];
      assert.ok(
        warnings.includes(iosTargetActivationDisclosure(fact)),
        `warnings did not carry the shared disclosure sentence: ${JSON.stringify(warnings)}`,
      );

      // The repair is a fact about one command, not a property of the session: with the app already
      // foreground again, the next capture must say nothing.
      const settled = await runStep(context, 'snapshot after the repair settled', [
        'snapshot',
        '-i',
      ]);
      assert.equal(
        settled.json?.data?.targetActivation,
        undefined,
        `second capture re-disclosed a repair it did not perform: ${JSON.stringify(
          settled.json?.data?.warnings,
        )}`,
      );
      assert.equal(
        String(settled.json?.data?.warning ?? '').includes('was not foreground'),
        false,
        'second capture re-disclosed a repair it did not perform',
      );
    } finally {
      await cleanupSession(context);
    }
  },
);

/** Poll `snapshot -i` until the runner reports the repair, or fail with the last response. */
async function captureUntilDisclosed(context: LiveContext) {
  const deadline = Date.now() + HANDOFF_DEADLINE_MS;
  let last: Awaited<ReturnType<typeof runStep>> | undefined;
  while (Date.now() < deadline) {
    last = await runStep(context, 'snapshot after handoff', ['snapshot', '-i'], {
      allowFailure: true,
    });
    if (last.json?.data?.targetActivation !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
  }
  assert.fail(
    `no foreground disclosure within ${HANDOFF_DEADLINE_MS}ms of the handoff to ` +
      `${HANDOFF_BUNDLE_ID}: ${JSON.stringify(last?.json ?? null)}`,
  );
}

async function checksum(filePath: string): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto
    .createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

async function exists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).size > 0;
  } catch {
    return false;
  }
}
