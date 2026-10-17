import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '@agent-device/contracts/interaction-guarantees';
import type { Point } from '@agent-device/kernel/snapshot';
import { INTERACTION_ERROR_REASONS } from '@agent-device/selectors/interaction-error';
import { selector } from '../../../src/commands/interaction/runtime/selector-read-utils.ts';
import { assertRpcError, assertRpcOk } from '../provider-scenarios/assertions.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from '../provider-scenarios/test-timeouts.ts';
import { scenarioName, scenarioNames } from './coverage-manifest.ts';
import { RUNTIME_SELECTOR_COVERAGE } from './runtime-selector.coverage.ts';
import {
  closedDrawerSnapshot,
  continueButtonAtRect,
  continueButtonSnapshot,
  coveredButtonSnapshot,
  keyboardCoveredTabBarSnapshot,
  drawerWithVisibleTwinSnapshot,
  equivalentWrapperChainSnapshot,
  edgeGrazingDrawerSnapshot,
  fullyTiledParentSnapshot,
  nonHittableButtonSnapshot,
  RUNNER_CONTINUE_NODES,
  settledWelcomeSnapshot,
  viewportOnlySnapshot,
} from './fixtures.ts';
import { createContractClock, createContractDevice } from './runtime-harness.ts';
import { runnerSnapshotEntry, runnerTapEntry, withIosContractDaemon } from './daemon-harness.ts';

// ADR 0011 Layer 3, runtime-selector path: daemon tree capture, selector
// chain resolution, guarded coordinate tap. One behavior assertion per
// claimed matrix cell — the deep rule semantics stay in the unit suites.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(RUNTIME_SELECTOR_COVERAGE, guarantee);

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'disambiguation')[0]!, async () => {
  const taps: Point[] = [];
  const device = createContractDevice(equivalentWrapperChainSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.click(selector('label=Chat'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.ref, 'e3');
  assert.equal(result.resolution?.kind, 'disambiguated');
  if (result.resolution?.kind !== 'disambiguated') {
    assert.fail('expected structural-equivalence disclosure');
  }
  assert.equal(result.resolution.tiebreak, 'structural-equivalence');
  assert.deepEqual(taps, [{ x: 70, y: 765 }]);
});

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'disambiguation')[1]!, async () => {
  const taps: Point[] = [];
  const device = createContractDevice(drawerWithVisibleTwinSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(selector('label=Profile'), { session: 'default' }),
    (error: unknown) => {
      const typed = error as { code?: unknown; details?: Record<string, unknown> };
      assert.equal(typed.code, 'AMBIGUOUS_MATCH');
      assert.equal(typed.details?.matches, 2);
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'offscreen')[0]!, async () => {
  const taps: Point[] = [];
  const device = createContractDevice(closedDrawerSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Explore'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /off-screen element and is not safe to press/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_selector');
      assert.ok(typeof details?.hint === 'string');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'offscreen')[1]!, async () => {
  const taps: Point[] = [];
  const device = createContractDevice(edgeGrazingDrawerSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Explore'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_selector');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenario('occlusion'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(coveredButtonSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(selector('label="Save draft"'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /covered by another visible element/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, INTERACTION_ERROR_REASONS.targetCovered);
      assert.equal(details?.dispatched, 'no');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenario('keyboardOcclusion'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(keyboardCoveredTabBarSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(selector('label="Form"'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /behind the visible keyboard/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'tap_keyboard_occludes_target');
      assert.ok(typeof details?.hint === 'string');
      assert.deepEqual(details?.keyboardFrame, { x: 0, y: 583, width: 402, height: 291 });
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenario('parentOwnedTouchPoint'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(fullyTiledParentSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(selector('label=Card'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: unknown }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Selector label=Card has no parent-owned touch point/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'covered_by_interactive_descendants');
      assert.equal(details?.selector, 'label=Card');
      assert.equal(details?.ref, undefined);
      assert.deepEqual(details?.competitorRefs, ['@e3', '@e4', '@e5', '@e6', '@e7']);
      assert.equal(details?.competitorCount, 10);
      assert.match(String(details?.hint), /more specific selector/);
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenario('nonHittable'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(nonHittableButtonSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(taps.length, 1);
  assert.equal(result.kind, 'selector');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
});

// #3471 targetStability: the session's last action animated the UI, so the rect this press resolved
// may be a position the target has already left. The gate re-observes past the window: two agreeing
// observations are the resting position it taps, and two disagreeing ones are a refusal.
test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'targetStability')[0]!, async () => {
  const taps: Point[] = [];
  let captures = 0;
  const resting = continueButtonAtRect(10, 20);
  const device = createContractDevice(continueButtonAtRect(240, 20), {
    // A slide-in the resolution capture caught mid-flight, at rest by the gate's re-observations.
    captureSnapshot: async () => ({
      snapshot: captures++ === 0 ? continueButtonAtRect(240, 20) : resting,
    }),
    tap: async (_context, point) => {
      taps.push(point);
    },
    clock: createContractClock(),
    sessionState: {
      movingTargetBaseline: { finishedAt: 0, tree: { nodes: viewportOnlySnapshot().nodes } },
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  // Tapped at the resting centre (10+50, 20+20), not the mid-flight one it resolved.
  assert.deepEqual(taps, [{ x: 60, y: 40 }]);
  assert.equal(captures, 3, 'one resolution capture plus the gate two re-observations');
});

// The wiring, through the real daemon route rather than an injected session record: press A must
// LEAVE the tree it acted through on the session (#3471) and press B must be screened against it.
// Deleting either half of that — the writer in `dispatchRuntimeInteraction` or the carrier in
// `toRuntimeSessionRecord` — leaves B idle, so it taps the vacated point and this fails.
//
// Flake surface: this route installs no runtime clock (production never does), so the 500 ms window
// runs on the wall clock and B must reach its gate read inside it. A host loaded enough to starve
// this process past the window sends B idle, and B taps — the same `Unexpected provider call:
// ios.runner.tap` a wiring regression gives. Re-run it unloaded before reading it as one.
test(
  scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'targetStability')[1]!,
  async () => {
    // The shared runner tree with the Continue button's frame translated to `y`.
    const runnerNodesAtY = (y: number) =>
      RUNNER_CONTINUE_NODES.map((node) =>
        node.index === 1 ? { ...node, rect: { ...node.rect, y } } : node,
      );
    await withIosContractDaemon(
      [
        // A resolves and taps at y=300; B resolves at 360 and its two re-observations disagree.
        runnerSnapshotEntry(runnerNodesAtY(300)),
        runnerTapEntry({ x: 200, y: 322 }),
        runnerSnapshotEntry(runnerNodesAtY(360)),
        runnerSnapshotEntry(runnerNodesAtY(420)),
        runnerSnapshotEntry(runnerNodesAtY(480)),
      ],
      async (daemon, transcript) => {
        assertRpcOk(await daemon.callCommand('press', ['label=Continue']));
        const refusal = await daemon.callCommand('press', ['label=Continue']);
        const data = assertRpcError(
          refusal,
          500,
          'COMMAND_FAILED',
          /label=Continue had no confirmed resting position when the transition window ran out/,
        );
        const details = data.details as Record<string, unknown>;
        assert.equal(details.reason, INTERACTION_ERROR_REASONS.targetStillMoving);
        assert.equal(details.dispatched, 'no');
        assert.deepEqual(details.rect, { x: 100, y: 360, width: 200, height: 44 });
        assert.deepEqual(details.movedToRect, { x: 100, y: 480, width: 200, height: 44 });
        // A: one capture. B: its resolution plus the gate's two. Any other count is the harness's
        // `assertComplete` failing, which is what makes the unused deletion above visible.
        assert.equal(
          transcript.calls.filter((call) => call.command === 'ios.runner.snapshot').length,
          4,
        );
        assert.equal(
          transcript.calls.filter((call) => call.command === 'ios.runner.tap').length,
          1,
        );
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

// The cost contract, as a scenario: the gate reads a tree the session already holds, so a press
// whose target the previous action left in place spends the one capture it always spent.
test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'targetStability')[2]!, async () => {
  const taps: Point[] = [];
  let captures = 0;
  const resting = continueButtonAtRect(10, 20);
  const device = createContractDevice(resting, {
    captureSnapshot: async () => {
      captures += 1;
      return { snapshot: resting };
    },
    tap: async (_context, point) => {
      taps.push(point);
    },
    clock: createContractClock(),
    sessionState: {
      movingTargetBaseline: { finishedAt: 0, tree: { nodes: resting.nodes } },
    },
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.deepEqual(taps, [{ x: 60, y: 40 }]);
  assert.equal(captures, 1, 'a stationary target must not pay for a re-observation');
});

test(scenario('verifyEvidence'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    verify: true,
  });

  assert.equal(result.kind, 'selector');
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, false);
  assert.ok(result.evidence?.digest.startsWith('ax1:'));
});

test(scenario('settleObservation'), async () => {
  const before = continueButtonSnapshot();
  const after = settledWelcomeSnapshot();
  let captures = 0;
  const device = createContractDevice(before, {
    // Resolution capture sees the pre-action tree; every settle capture sees
    // the (already stable) post-action tree.
    captureSnapshot: async () => ({ snapshot: captures++ === 0 ? before : after }),
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
    settle: { quietMs: 25, timeoutMs: 2_000 },
  });

  assert.equal(result.kind, 'selector');
  const settle = result.settle;
  assert.ok(settle, 'press --settle must return a settle observation');
  assert.equal(settle.settled, true);
  assert.ok(settle.captures >= 2);
  assert.deepEqual(settle.diff?.summary, { additions: 1, removals: 1, unchanged: 0 });
  const added = settle.diff?.lines.find((line) => line.kind === 'added');
  assert.match(added?.text ?? '', /Welcome!/);
  // Fresh refs ride the diff: the added line's ref resolves on the stored
  // settled tree.
  assert.equal(added?.ref, 'e1');
});

test(scenario('errorTaxonomy'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  await assert.rejects(
    () => device.interactions.press(selector('label=Missing'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Selector did not match/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.match(String(details?.hint), /snapshot -i/);
      return true;
    },
  );
});

test(
  scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'errorTaxonomy')[1]!,
  async () => {
    await withIosContractDaemon(
      [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerSnapshotEntry(RUNNER_CONTINUE_NODES)],
      async (daemon) => {
        const press = await daemon.callCommand('press', ['label=Missing']);
        const error = assertRpcError(press, 500, 'COMMAND_FAILED', /Selector did not match/);
        assert.equal((error.details as Record<string, unknown>)?.dispatched, 'no');
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(scenario('responseIdentity'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.deepEqual(result.target, { kind: 'selector', selector: 'label=Continue' });
  assert.equal(result.node?.label, 'Continue');
  assert.ok(Array.isArray(result.selectorChain) && result.selectorChain.length > 0);
});

test(
  scenario('responseConstruction'),
  async () => {
    await withIosContractDaemon(
      [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerTapEntry({ x: 200, y: 322 })],
      async (daemon) => {
        const press = await daemon.callCommand('press', ['label=Continue']);
        const data = assertRpcOk(press);
        // Canonical selector response set from the shared construction site.
        assert.equal(data.x, 200);
        assert.equal(data.y, 322);
        assert.equal(data.selector, 'label=Continue');
        assert.ok(Array.isArray(data.selectorChain));
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'resolutionDisclosure')[0]!, async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Continue'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.deepEqual(result.resolution, { source: 'runtime', phase: 'pre-action', kind: 'unique' });
});

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'resolutionDisclosure')[1]!, async () => {
  const device = createContractDevice(equivalentWrapperChainSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(selector('label=Chat'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  const resolution = result.resolution;
  assert.equal(resolution?.kind, 'disambiguated');
  if (resolution?.kind !== 'disambiguated') return;
  assert.equal(resolution.source, 'runtime');
  assert.equal(resolution.phase, 'pre-action');
  assert.equal(resolution.matchCount, 3);
  assert.equal(resolution.tiebreak, 'structural-equivalence');
  assert.equal(resolution.winnerDiagnostic.diagnosticRef, 'diag-e3');
  assert.equal(resolution.winnerDiagnostic.label, 'Chat');
  assert.equal(resolution.alternatives.length, 2);
  // The winner never appears among its own alternatives.
  assert.ok(!resolution.alternatives.some((entry) => entry.diagnosticRef === 'diag-e3'));
});
