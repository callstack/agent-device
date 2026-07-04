import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import { AppError } from '../../../src/kernel/errors.ts';
import { assertRpcError, assertRpcOk } from '../provider-scenarios/assertions.ts';
import { scenarioName } from './coverage-manifest.ts';
import { DIRECT_IOS_SELECTOR_COVERAGE } from './direct-ios-selector.coverage.ts';
import {
  RUNNER_CHANGED_NODES,
  RUNNER_CLOSED_DRAWER_NODES,
  RUNNER_CONTINUE_NODES,
} from './fixtures.ts';
import {
  runnerSnapshotEntry,
  runnerTapEntry,
  runnerTapErrorEntry,
  withIosContractDaemon,
} from './daemon-harness.ts';

// ADR 0011 Layer 3, direct-ios-selector path: a simple selector click on an
// iOS session is sent to the XCTest runner without a daemon tree capture.
// Path forcing is natural: `click <single-term selector>` with default flags
// takes the direct path; the transcript proves it (the runner receives a
// selector-keyed tap, not a coordinate one).

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(DIRECT_IOS_SELECTOR_COVERAGE, guarantee);

test(scenario('responseConstruction'), async () => {
  await withIosContractDaemon([runnerTapEntry({ x: 150, y: 200 })], async (daemon, transcript) => {
    const click = await daemon.callCommand('click', ['label=Continue']);
    const data = assertRpcOk(click);

    // The direct path really ran: the single runner call is a selector-keyed
    // tap, with no snapshot capture before it.
    const tapRequest = transcript.calls[0]?.request as Record<string, unknown> | undefined;
    assert.equal(transcript.calls[0]?.command, 'ios.runner.tap');
    assert.equal(tapRequest?.selectorKey, 'label');
    assert.equal(tapRequest?.selectorValue, 'Continue');

    // Canonical runner-payload response set from the shared construction site.
    assert.equal(data.x, 150);
    assert.equal(data.y, 200);
    assert.equal(data.selector, 'label=Continue');
    assert.match(String(data.message), /Tapped label=Continue/);
  });
});

test(scenario('offscreen'), async () => {
  await withIosContractDaemon(
    [
      // The runner refuses a hittable match whose frame lies outside the app
      // frame (TapPointPolicy); the daemon must fall back to the runtime path,
      // which refuses with the actionable offscreen shape instead of tapping.
      runnerTapErrorEntry(
        new AppError('ELEMENT_OFFSCREEN', 'Element frame is outside the app frame'),
      ),
      runnerSnapshotEntry(RUNNER_CLOSED_DRAWER_NODES),
    ],
    async (daemon) => {
      const click = await daemon.callCommand('click', ['label=Explore']);
      const error = assertRpcError(
        click,
        'COMMAND_FAILED',
        /off-screen element and is not safe to click/,
      );
      const details = error.details as Record<string, unknown> | undefined;
      assert.equal(details?.reason, 'offscreen_selector');
      assert.ok(typeof error.hint === 'string');
    },
  );
});

test(scenario('verifyEvidence'), async () => {
  await withIosContractDaemon(
    [
      runnerSnapshotEntry(RUNNER_CONTINUE_NODES),
      runnerTapEntry({ x: 200, y: 322 }),
      runnerSnapshotEntry(RUNNER_CHANGED_NODES),
    ],
    async (daemon, transcript) => {
      const click = await daemon.callCommand('click', ['label=Continue'], { verify: true });
      const data = assertRpcOk(click);

      // --verify disables the direct path: the first runner call is the
      // runtime path's tree capture, and the tap is coordinate-keyed.
      assert.equal(transcript.calls[0]?.command, 'ios.runner.snapshot');
      const tapRequest = transcript.calls.find((call) => call.command === 'ios.runner.tap')
        ?.request as Record<string, unknown> | undefined;
      assert.equal(tapRequest?.selectorKey, undefined);
      assert.equal(tapRequest?.x, 200);

      const evidence = data.evidence as Record<string, unknown> | undefined;
      assert.ok(evidence, 'click --verify must return evidence');
      assert.equal(evidence.changedFromBefore, true);
      assert.equal(typeof evidence.digest, 'string');
      // The verify capture's tree must never be serialized into the response.
      assert.equal(data.nodes, undefined);
    },
  );
});
