import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import type { Point } from '../../../src/kernel/snapshot.ts';
import { ref } from '../../../src/commands/index.ts';
import { assertRpcOk } from '../provider-scenarios/assertions.ts';
import { scenarioName, scenarioNames } from './coverage-manifest.ts';
import { RUNTIME_REF_COVERAGE } from './runtime-ref.coverage.ts';
import {
  closedDrawerSnapshot,
  continueButtonSnapshot,
  coveredButtonSnapshot,
  nonHittableCellSnapshot,
  RUNNER_CONTINUE_NODES,
  settledWelcomeSnapshot,
} from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';
import { runnerSnapshotEntry, runnerTapEntry, withIosContractDaemon } from './daemon-harness.ts';

// ADR 0011 Layer 3, runtime-ref path: session snapshot ref lookup, guarded
// coordinate tap. The backend has no tapTarget/fillTarget, so @ref targets
// resolve through the runtime path by construction.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(RUNTIME_REF_COVERAGE, guarantee);

test(scenario('occlusion'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(coveredButtonSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    /Ref @e2 is covered by another visible element/,
  );
  assert.deepEqual(taps, []);
});

test(scenario('offscreen'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(closedDrawerSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Ref @e2 is off-screen and not safe to click/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_ref');
      assert.ok(typeof details?.hint === 'string');
      return true;
    },
  );
  assert.deepEqual(taps, []);
});

test(scenario('nonHittable'), async () => {
  const taps: Point[] = [];
  const device = createContractDevice(nonHittableCellSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  const result = await device.interactions.press(ref('@e2'), { session: 'default' });

  assert.equal(taps.length, 1);
  assert.equal(result.kind, 'ref');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
});

test(scenario('verifyEvidence'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(ref('@e1'), {
    session: 'default',
    verify: true,
  });

  assert.equal(result.kind, 'ref');
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, false);
  assert.ok(result.evidence?.digest.startsWith('ax1:'));
});

test(scenario('settleObservation'), async () => {
  // The @ref resolves against the STORED session tree (no resolution capture);
  // the settle loop's captures see the post-action tree.
  const device = createContractDevice(continueButtonSnapshot(), {
    captureSnapshot: async () => ({ snapshot: settledWelcomeSnapshot() }),
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.press(ref('@e1'), {
    session: 'default',
    settle: { quietMs: 25, timeoutMs: 2_000 },
  });

  assert.equal(result.kind, 'ref');
  const settle = result.settle;
  assert.ok(settle, 'press @ref --settle must return a settle observation');
  assert.equal(settle.settled, true);
  // Baseline is the stored pre-action tree the ref was resolved on.
  assert.deepEqual(settle.diff?.summary, { additions: 1, removals: 1, unchanged: 0 });
  assert.equal(settle.diff?.lines.find((line) => line.kind === 'added')?.ref, 'e1');
});

test(scenario('errorTaxonomy'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  await assert.rejects(
    () => device.interactions.click(ref('@e9'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Ref @e9 not found or has no bounds/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.match(String(details?.hint), /refs expire/i);
      return true;
    },
  );
});

test(scenario('responseIdentity'), async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(ref('@e1'), { session: 'default' });

  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e1' });
  assert.equal(result.node?.label, 'Continue');
  assert.ok(Array.isArray(result.selectorChain) && result.selectorChain.length > 0);
});

test(scenario('responseConstruction'), async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerTapEntry({ x: 200, y: 322 })],
    async (daemon) => {
      const snapshot = await daemon.callCommand('snapshot', [], { snapshotInteractiveOnly: true });
      assertRpcOk(snapshot);

      const press = await daemon.callCommand('press', ['@e2']);
      const data = assertRpcOk(press);
      // Canonical ref response set from the shared construction site.
      assert.equal(data.ref, 'e2');
      assert.equal(data.x, 200);
      assert.equal(data.y, 322);
      assert.match(String(data.message), /Tapped @e2/);
    },
  );
});

test(scenarioNames(RUNTIME_REF_COVERAGE, 'resolutionDisclosure')[0]!, async () => {
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(ref('@e1'), { session: 'default' });

  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.resolution, { source: 'ref', phase: 'pre-action', kind: 'exact' });
});

test(scenarioNames(RUNTIME_REF_COVERAGE, 'resolutionDisclosure')[1]!, async () => {
  const taps: Point[] = [];
  const device = createContractDevice(continueButtonSnapshot(), {
    tap: async (_context, point) => {
      taps.push(point);
    },
  });

  // @e9 is not in the stored tree; the recorded trailing label recovers the
  // Continue button by first label match.
  const result = await device.interactions.click(ref('@e9', { fallbackLabel: 'Continue' }), {
    session: 'default',
  });

  assert.equal(taps.length, 1);
  assert.equal(result.kind, 'ref');
  assert.equal(result.node?.label, 'Continue');
  assert.deepEqual(result.resolution, {
    source: 'ref',
    phase: 'pre-action',
    kind: 'label-fallback',
  });
});
