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
  RUNNER_COVERED_NODES,
  RUNNER_NON_HITTABLE_NODES,
} from './fixtures.ts';
import {
  runnerSnapshotEntry,
  runnerTapEntry,
  runnerTapErrorEntry,
  runnerTypeEntry,
  withIosContractDaemon,
} from './daemon-harness.ts';

// ADR 0011 Layer 3, direct-ios-selector path: a simple selector click on an
// iOS session is sent to the XCTest runner without a daemon tree capture.
// Path forcing is natural: `click <single-term selector>` with default flags
// takes the direct path; the transcript proves it (the runner receives a
// selector-keyed tap, not a coordinate one).

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(DIRECT_IOS_SELECTOR_COVERAGE, guarantee);

const RECORDING_TARGET_NODES = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'Button',
    identifier: 'continue',
    label: 'Continue',
    rect: { x: 40, y: 160, width: 120, height: 44 },
    enabled: true,
    hittable: true,
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'TextField',
    identifier: 'email',
    label: 'Email',
    rect: { x: 40, y: 240, width: 280, height: 44 },
    enabled: true,
    hittable: true,
  },
] as const;

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

test(scenario('resolutionDisclosure'), async () => {
  await withIosContractDaemon([runnerTapEntry({ x: 150, y: 200 })], async (daemon) => {
    const click = await daemon.callCommand('click', ['label=Continue']);
    const data = assertRpcOk(click);

    // No daemon tree exists on this path: the disclosure never fabricates a
    // match count or candidates.
    assert.deepEqual(data.resolution, { source: 'direct-ios', kind: 'not-observed' });
  });
});

test('recorded simple iOS selector click and fill use runtime resolution and persist target-v1 evidence', async () => {
  await withIosContractDaemon(
    [
      runnerSnapshotEntry(RECORDING_TARGET_NODES),
      runnerTapEntry({ x: 100, y: 182 }),
      runnerSnapshotEntry(RECORDING_TARGET_NODES),
      runnerTypeEntry({ x: 180, y: 262 }),
    ],
    async (daemon, transcript) => {
      assertRpcOk(await daemon.callCommand('click', ['id=continue']));
      assertRpcOk(await daemon.callCommand('fill', ['id=email', 'ada@example.com']));

      assert.equal(transcript.calls[0]?.command, 'ios.runner.snapshot');
      assert.equal(transcript.calls[1]?.command, 'ios.runner.tap');
      assert.equal(transcript.calls[2]?.command, 'ios.runner.snapshot');
      assert.equal(transcript.calls[3]?.command, 'ios.runner.type');
      for (const call of [transcript.calls[1], transcript.calls[3]]) {
        const request = call?.request as Record<string, unknown> | undefined;
        assert.equal(request?.selectorKey, undefined);
      }

      const actions = daemon
        .session()
        ?.actions.filter((action) => action.command === 'click' || action.command === 'fill');
      assert.deepEqual(
        actions?.map((action) => action.command),
        ['click', 'fill'],
      );
      const targetIdentities = actions?.map((action) => {
        const evidence = action.targetEvidence as Record<string, unknown> | undefined;
        return {
          id: evidence?.id,
          role: evidence?.role,
          label: evidence?.label,
          verification: evidence?.verification,
        };
      });
      assert.deepEqual(targetIdentities, [
        { id: 'continue', role: 'button', label: 'Continue', verification: 'verified' },
        { id: 'email', role: 'textfield', label: 'Email', verification: 'verified' },
      ]);
    },
    { saveScript: true },
  );
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

test(scenario('settleObservation'), async () => {
  await withIosContractDaemon(
    [
      // --settle disables the direct path: runtime tree capture, coordinate
      // tap, then the settle loop's two stable captures of the changed tree.
      runnerSnapshotEntry(RUNNER_CONTINUE_NODES),
      runnerTapEntry({ x: 200, y: 322 }),
      runnerSnapshotEntry(RUNNER_CHANGED_NODES),
      runnerSnapshotEntry(RUNNER_CHANGED_NODES),
    ],
    async (daemon, transcript) => {
      const click = await daemon.callCommand('click', ['label=Continue'], {
        settle: true,
        settleQuietMs: 25,
        timeoutMs: 2_000,
      });
      const data = assertRpcOk(click);

      assert.equal(transcript.calls[0]?.command, 'ios.runner.snapshot');
      const tapRequest = transcript.calls.find((call) => call.command === 'ios.runner.tap')
        ?.request as Record<string, unknown> | undefined;
      assert.equal(tapRequest?.selectorKey, undefined);
      assert.equal(tapRequest?.x, 200);

      const settle = data.settle as Record<string, unknown> | undefined;
      assert.ok(settle, 'click --settle must return a settle observation');
      assert.equal(settle.settled, true);
      assert.equal(typeof settle.refsGeneration, 'number');
      const diff = settle.diff as
        | { summary: Record<string, unknown>; lines: Array<Record<string, unknown>> }
        | undefined;
      assert.ok(diff, 'settle observation must carry the diff');
      assert.deepEqual(diff.summary, { additions: 1, removals: 1, unchanged: 1 });
      // The settled tree itself is never serialized into the response.
      assert.equal(data.nodes, undefined);
    },
  );
});

test(scenario('errorTaxonomy'), async () => {
  await withIosContractDaemon(
    [
      runnerTapErrorEntry(new AppError('ELEMENT_NOT_FOUND', 'element not found')),
      // Runtime fallback resolution: interactive-only capture, then the
      // full-tree retry — neither contains the selector.
      runnerSnapshotEntry(RUNNER_CONTINUE_NODES),
      runnerSnapshotEntry(RUNNER_CONTINUE_NODES),
    ],
    async (daemon) => {
      const click = await daemon.callCommand('click', ['label=Missing']);
      const error = assertRpcError(click, 'COMMAND_FAILED', /did not match/);
      // The delegated taxonomy: runtime diagnostics and the actionable hint,
      // not the runner's bare "element not found".
      assert.ok(typeof error.hint === 'string' && error.hint.length > 0);
    },
  );
});

test(scenario('occlusion'), async () => {
  await withIosContractDaemon(
    [
      runnerTapErrorEntry(new AppError('ELEMENT_NOT_FOUND', 'element not found')),
      runnerSnapshotEntry(RUNNER_COVERED_NODES),
      runnerSnapshotEntry(RUNNER_COVERED_NODES),
    ],
    async (daemon) => {
      const click = await daemon.callCommand('click', ['label="Save draft"']);
      const error = assertRpcError(click, 'COMMAND_FAILED', /covered by another visible element/);
      const details = error.details as Record<string, unknown> | undefined;
      assert.equal(details?.interactionBlocked, 'covered');
    },
  );
});

test(scenario('nonHittable'), async () => {
  await withIosContractDaemon(
    [
      runnerTapErrorEntry(new AppError('ELEMENT_NOT_FOUND', 'element not found')),
      runnerSnapshotEntry(RUNNER_NON_HITTABLE_NODES),
      runnerTapEntry({ x: 200, y: 330 }),
    ],
    async (daemon, transcript) => {
      const click = await daemon.callCommand('click', ['label="Recents row"']);
      const data = assertRpcOk(click);
      // Delegation really happened: the second tap is coordinate-keyed.
      const fallbackTap = transcript.calls.at(-1)?.request as Record<string, unknown> | undefined;
      assert.equal(transcript.calls.at(-1)?.command, 'ios.runner.tap');
      assert.equal(fallbackTap?.selectorKey, undefined);
      assert.equal(data.targetHittable, false);
      assert.match(String(data.hint ?? ''), /hittable: false/);
    },
  );
});
