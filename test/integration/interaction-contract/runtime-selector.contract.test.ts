import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import type { Point } from '../../../src/kernel/snapshot.ts';
import { selector } from '../../../src/commands/index.ts';
import { assertRpcOk } from '../provider-scenarios/assertions.ts';
import { scenarioName, scenarioNames } from './coverage-manifest.ts';
import { RUNTIME_SELECTOR_COVERAGE } from './runtime-selector.coverage.ts';
import {
  closedDrawerSnapshot,
  continueButtonSnapshot,
  coveredButtonSnapshot,
  drawerWithVisibleTwinSnapshot,
  edgeGrazingDrawerSnapshot,
  manyMatchingItemRowsSnapshot,
  nonHittableButtonSnapshot,
  RUNNER_CONTINUE_NODES,
  settledWelcomeSnapshot,
} from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';
import { runnerSnapshotEntry, runnerTapEntry, withIosContractDaemon } from './daemon-harness.ts';

// ADR 0011 Layer 3, runtime-selector path: daemon tree capture, selector
// chain resolution, guarded coordinate tap. One behavior assertion per
// claimed matrix cell — the deep rule semantics stay in the unit suites.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(RUNTIME_SELECTOR_COVERAGE, guarantee);

test(scenario('disambiguation'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(drawerWithVisibleTwinSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.click(selector('label=Profile'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  assert.equal(result.node?.ref, 'e2');
  assert.deepEqual(taps, [{ x: 120, y: 765 }]);
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
    /covered by another visible element/,
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

test(scenario('responseConstruction'), async () => {
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
});

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
  const device = createContractDevice(drawerWithVisibleTwinSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(selector('label=Profile'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  const resolution = result.resolution;
  assert.equal(resolution?.kind, 'disambiguated');
  if (resolution?.kind !== 'disambiguated') return;
  assert.equal(resolution.source, 'runtime');
  assert.equal(resolution.phase, 'pre-action');
  assert.equal(resolution.matchCount, 2);
  // The visible bottom-tab twin (e2) won; the off-screen drawer item lost.
  assert.equal(resolution.tiebreak, 'visible');
  assert.equal(resolution.winnerDiagnostic.diagnosticRef, 'diag-e2');
  assert.equal(resolution.winnerDiagnostic.label, 'Profile');
  assert.equal(resolution.alternatives.length, 1);
  assert.equal(resolution.alternatives[0]?.diagnosticRef, 'diag-e3');
  // The winner never appears among its own alternatives.
  assert.ok(!resolution.alternatives.some((entry) => entry.diagnosticRef === 'diag-e2'));
});

test(scenarioNames(RUNTIME_SELECTOR_COVERAGE, 'resolutionDisclosure')[2]!, async () => {
  const device = createContractDevice(manyMatchingItemRowsSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(selector('label=Item'), {
    session: 'default',
  });

  assert.equal(result.kind, 'selector');
  const resolution = result.resolution;
  assert.equal(resolution?.kind, 'disambiguated');
  if (resolution?.kind !== 'disambiguated') return;
  assert.equal(resolution.matchCount, 7);
  assert.equal(resolution.tiebreak, 'deepest');
  assert.equal(resolution.alternatives.length, 5);
  assert.ok(
    !resolution.alternatives.some(
      (entry) => entry.diagnosticRef === resolution.winnerDiagnostic.diagnosticRef,
    ),
  );
});
