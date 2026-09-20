import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  IOS_TARGET_ACTIVATION_PRIOR_STATES,
  isIosTargetActivationReason,
  iosTargetActivationDisclosure,
  type IosTargetActivation,
} from '@agent-device/contracts/ios-target-activation';
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
 * What it asserts is the `data.warnings` sentence, because that is everything this branch publishes:
 * the typed `data.targetActivation` field is the daemon seam that lands in #2693, and a lane reading
 * it here would time out against this head.
 *
 * MANUAL, ENV-GATED LANE. It is deliberately absent from the `ios.yml` and `replays-manual.yml` test
 * lists: on the CI-hosted simulator the runner reads its own target as `.runningForeground` while a
 * foreign app is demonstrably on screen, so that host owes no repair and no disclosure
 * ([#2696](https://github.com/callstack/agent-device/issues/2696)). Running it there measures
 * `XCUIApplication.state` on a headless simulator, not this feature.
 *
 * Run it against a local simulator or a physical device:
 *
 *   AGENT_DEVICE_IOS_E2E=1 AGENT_DEVICE_IOS_E2E_TIER=smoke \
 *   AGENT_DEVICE_FIXTURE_APP_PATH=<fixture .app> AGENT_DEVICE_FIXTURE_APP_ID=com.callstack.agentdevicelab \
 *   AGENT_DEVICE_IOS_UDID=<udid> node --experimental-strip-types scripts/node-test-tmpdir.ts --test \
 *   test/integration/smoke-ios-target-activation.test.ts
 *
 * It installs the fixture through the public CLI, so it needs no pre-installed app.
 */

const enabled = process.env.AGENT_DEVICE_IOS_E2E === '1';
// Safari, through LaunchServices, the way an in-app external link does it. Launching Settings
// directly (`simctl launch com.apple.Preferences`) also changes the screen, and the screenshot guard
// below would still pass, but on the local simulator the runner then reads its own target as
// foreground for the whole polling window — the same state divergence recorded in #2696, which this
// lane exists to avoid mistaking for a missing disclosure.
const HANDOFF_URL = 'https://example.com';
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

      // The handoff only means something once the session app is on screen. `open` returns while a
      // freshly installed app is still drawing — CI's before-handoff screenshot was a blank status
      // bar — and handing off from there asks the runner about an app that never reached foreground,
      // which is not the question this lane asks. The gate is a string the app draws on any of its
      // own surfaces — the release home screen and a development build's server menu both carry it —
      // because which screen the fixture draws is not what this lane is about, and a lane that only
      // passes on one build variant could not be run manually against a dev build at all.
      await runStep(context, 'wait for the fixture to render', [
        'wait',
        'text',
        'Agent Device Tester',
        '30000',
      ]);

      // Screenshot is a lifecycle command: it serves whatever is foreground without touching the
      // bound app, so it is the observation the repair would otherwise contradict.
      const before = path.join(context.artifactDir, 'target-activation-before.png');
      await runStep(context, 'screenshot session app', ['screenshot', '--out', before]);
      assert.ok(await exists(before), `screenshot wrote no artifact: ${before}`);

      const foreign = path.join(context.artifactDir, 'target-activation-foreign.png');

      // Hand off to Safari: the session stays bound to the fixture app while another app takes the
      // screen, which is the state the next capture has to repair.
      const handoff = await runCmd('xcrun', ['simctl', 'openurl', context.udid, HANDOFF_URL]);
      assert.equal(handoff.exitCode, 0, `simctl openurl ${HANDOFF_URL} failed: ${handoff.stderr}`);
      await runStep(context, 'screenshot after handoff', ['screenshot', '--out', foreign]);
      assert.ok(await exists(foreign), `post-handoff screenshot wrote no artifact: ${foreign}`);
      // A screenshot identical to the pre-handoff one means nothing moved to the foreground and the
      // lane would be waiting for a repair the device is not obliged to report.
      assert.notEqual(
        await checksum(before),
        await checksum(foreign),
        'the screen did not change after the handoff: nothing came forward to repair',
      );

      // Poll instead of sleeping a fixed window: the disclosure must arrive on the command that
      // paid for the repair, and a lane that never sees one is the regression this asserts against.
      const repaired = await captureUntilDisclosed(context);
      activationFactFrom(repaired.json!.data.warnings ?? []);

      // The repair is a fact about one command, not a property of the session: with the app already
      // foreground again, the next capture must say nothing.
      const settled = await runStep(context, 'snapshot after the repair settled', [
        'snapshot',
        '-i',
      ]);
      assert.equal(
        activationFactFrom(settled.json?.data?.warnings ?? []),
        undefined,
        `second capture re-disclosed a repair it did not perform: ${JSON.stringify(
          settled.json?.data?.warnings,
        )}`,
      );
    } catch (error) {
      throw await withRunnerLogEvidence(context, error);
    } finally {
      await cleanupSession(context);
    }
  },
);

/**
 * The runner writes what it decided — `AGENT_DEVICE_RUNNER_ACTIVATE`, `_SKIPPED`, and the stamped
 * fact — only to the session's `runner.log`, and the CI job uploads artifacts and not the state dir.
 * A lane that fails without that file leaves the reader guessing whether the runner declined to
 * activate, activated without stamping, or stamped something the decoder refused.
 */
async function withRunnerLogEvidence(context: LiveContext, error: unknown): Promise<Error> {
  const source = path.join(context.stateDir, 'sessions', context.session, 'runner.log');
  const destination = path.join(context.artifactDir, 'target-activation-runner.log');
  let note = `runner log not found at ${source}`;
  try {
    await fs.copyFile(source, destination);
    note = `runner log copied to ${destination}`;
  } catch {
    // The artifact is the point; a missing log is reported and the original failure still stands.
  }
  const message = error instanceof Error ? error.message : String(error);
  // A test reporter prints the stack, whose first line is the original error's own message, so a note
  // carried only on a copied stack never reaches a CI log. Both halves belong in the new message.
  return new Error(`${message}\n${note}`, { cause: error });
}

/** Poll `snapshot -i` until the runner discloses the repair, or fail with the last response. */
async function captureUntilDisclosed(context: LiveContext) {
  const deadline = Date.now() + HANDOFF_DEADLINE_MS;
  let last: Awaited<ReturnType<typeof runStep>> | undefined;
  while (Date.now() < deadline) {
    last = await runStep(context, 'snapshot after handoff', ['snapshot', '-i'], {
      allowFailure: true,
    });
    if (activationFactFrom(last.json?.data?.warnings ?? []) !== undefined) return last;
    await new Promise((resolve) => setTimeout(resolve, HANDOFF_POLL_MS));
  }
  assert.fail(
    `no foreground disclosure within ${HANDOFF_DEADLINE_MS}ms of the handoff to ` +
      `${HANDOFF_URL}: ${JSON.stringify(last?.json ?? null)}`,
  );
}

/**
 * Recovers the repair fact from the disclosure sentence in `data.warnings` and hands it back to the
 * shared builder, which must reproduce the response's sentence exactly. That is what makes the lane
 * assert the disclosure rather than a paraphrase of it, and it keeps the typed object out of the
 * picture so the lane runs against a head that publishes only the warning. A prior state outside the
 * declared set fails as a fact the runner could not have stamped — the declared set omits
 * `runningForeground` because the runner never activates there.
 */
function activationFactFrom(warnings: unknown[]): IosTargetActivation | undefined {
  const sentence = warnings.find(
    (warning): warning is string =>
      typeof warning === 'string' && warning.includes('The session app was not foreground'),
  );
  if (sentence === undefined) return undefined;
  const priorState = IOS_TARGET_ACTIVATION_PRIOR_STATES.find(
    (state) => state === /\(prior state ([A-Za-z]+)\)/.exec(sentence)?.[1],
  );
  const reason = /\(reason ([a-z_]+)\)/.exec(sentence)?.[1];
  const pid = /active accessibility session \(pid (\d+)\)/.exec(sentence)?.[1];
  assert.ok(
    priorState !== undefined && isIosTargetActivationReason(reason),
    `disclosure names no declared prior state and reason: ${sentence}`,
  );
  assert.match(
    sentence,
    /Re-capture now that the session app answers, or drive the other app in its own session/,
  );
  const fact: IosTargetActivation = {
    reason,
    priorState,
    ...(pid === undefined ? {} : { otherActiveApplicationPid: Number(pid) }),
  };
  assert.ok(
    warnings.includes(iosTargetActivationDisclosure(fact)),
    `disclosure is not the shared builder's sentence: ${sentence}`,
  );
  return fact;
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
