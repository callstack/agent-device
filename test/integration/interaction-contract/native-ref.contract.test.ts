import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import type { SnapshotState } from '../../../src/kernel/snapshot.ts';
import { ref } from '../../../src/commands/index.ts';
import { scenarioName } from './coverage-manifest.ts';
import { buildInteractionResponseData } from '../../../src/daemon/handlers/interaction-touch-response.ts';
import { NATIVE_REF_COVERAGE } from './native-ref.coverage.ts';
import {
  closedDrawerSnapshot,
  continueButtonSnapshot,
  settledWelcomeSnapshot,
  coveredButtonSnapshot,
  nonHittableCellSnapshot,
} from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';

// ADR 0011 Layer 3, native-ref path: click @ref / fill @ref dispatch straight
// to backend.tapTarget/fillTarget. Path forcing is natural: the backend
// declares tapTarget, so an @ref click takes the fast path by construction.
// The zero-round-trip preflight (preflightNativeRefInteraction) must run the
// shared guards against the stored session snapshot node first.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(NATIVE_REF_COVERAGE, guarantee);

function createNativeRefDevice(
  snapshot: SnapshotState,
  calls: string[],
): ReturnType<typeof createContractDevice> {
  return createContractDevice(snapshot, {
    platform: 'web',
    captureSnapshot: async () => {
      throw new Error('native ref preflight must not capture a snapshot');
    },
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return { ref: target.ref.replace(/^@/, '') };
    },
  });
}

test(scenario('occlusion'), async () => {
  const calls: string[] = [];
  const device = createNativeRefDevice(coveredButtonSnapshot(), calls);

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Ref @e2 is covered by another visible element/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.interactionBlocked, 'covered');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test(scenario('offscreen'), async () => {
  const calls: string[] = [];
  const device = createNativeRefDevice(closedDrawerSnapshot(), calls);

  await assert.rejects(
    () => device.interactions.click(ref('@e2'), { session: 'default' }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      // Also the errorTaxonomy claim: the preflight raises the runtime path's
      // exact shared shape — code, offscreen_ref reason, and hint.
      assert.equal((error as { code?: string }).code, 'COMMAND_FAILED');
      assert.match(error.message, /Ref @e2 is off-screen and not safe to click/);
      const details = (error as { details?: Record<string, unknown> }).details;
      assert.equal(details?.reason, 'offscreen_ref');
      assert.ok(typeof details?.hint === 'string');
      return true;
    },
  );
  assert.deepEqual(calls, []);
});

test(scenario('nonHittable'), async () => {
  const calls: string[] = [];
  const device = createNativeRefDevice(nonHittableCellSnapshot(), calls);

  const result = await device.interactions.click(ref('@e2'), { session: 'default' });

  // Annotation only: the backend still acts on the ref (no promotion on the
  // fast path) and the result carries the runtime path's annotation fields.
  assert.deepEqual(calls, ['@e2']);
  assert.equal(result.kind, 'ref');
  assert.equal(result.targetHittable, false);
  assert.match(result.hint ?? '', /hittable: false/);
});

test(scenario('verifyEvidence'), async () => {
  const calls: string[] = [];
  const snapshot = continueButtonSnapshot();
  const device = createContractDevice(snapshot, {
    platform: 'web',
    captureSnapshot: async () => ({ snapshot }),
    tap: async () => ({ ok: true }),
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return {};
    },
  });

  const result = await device.interactions.click(ref('@e1'), {
    session: 'default',
    verify: true,
  });

  // --verify delegates to the runtime-ref path: the fast path is skipped so a
  // baseline and post-action digest can be captured.
  assert.deepEqual(calls, []);
  assert.equal(result.kind, 'ref');
  assert.ok(result.evidence);
  assert.ok(result.evidence?.digest.startsWith('ax1:'));
});

test(scenario('settleObservation'), async () => {
  const calls: string[] = [];
  const device = createContractDevice(continueButtonSnapshot(), {
    platform: 'web',
    captureSnapshot: async () => ({ snapshot: settledWelcomeSnapshot() }),
    tap: async () => ({ ok: true }),
    tapTarget: async (_context, target) => {
      calls.push(target.ref);
      return {};
    },
  });

  const result = await device.interactions.click(ref('@e1'), {
    session: 'default',
    settle: { quietMs: 25, timeoutMs: 2_000 },
  });

  // --settle delegates to the runtime-ref path: the fast path is skipped so
  // the baseline and the settle captures exist.
  assert.deepEqual(calls, []);
  assert.equal(result.kind, 'ref');
  const settle = result.settle;
  assert.ok(settle, 'click @ref --settle must return a settle observation');
  assert.equal(settle.settled, true);
  assert.deepEqual(settle.diff?.summary, { additions: 1, removals: 1, unchanged: 0 });
});

test(scenario('responseIdentity'), async () => {
  const calls: string[] = [];
  const device = createNativeRefDevice(continueButtonSnapshot(), calls);

  const result = await device.interactions.click(ref('@e1'), { session: 'default' });

  assert.deepEqual(calls, ['@e1']);
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e1' });
  assert.deepEqual(result.backendResult, { ref: 'e1' });
});

test(scenario('responseConstruction'), async () => {
  const calls: string[] = [];
  const device = createNativeRefDevice(continueButtonSnapshot(), calls);

  const result = await device.interactions.click(ref('@e1'), { session: 'default' });

  // Canonical native-ref field set feeding the shared construction site: the
  // ref target and backend result are present, geometry fields the path
  // cannot provide stay absent instead of being hand-filled.
  assert.equal(result.kind, 'ref');
  assert.deepEqual(result.target, { kind: 'ref', ref: '@e1' });
  assert.deepEqual(result.backendResult, { ref: 'e1' });
  assert.equal(result.point, undefined);
  // ADR 0012 decision 3: the preflight's guard lookup supplies the
  // record-time evidence node on the runtime result.
  assert.equal(result.node?.ref, 'e1');
  assert.ok(Array.isArray(result.preActionNodes));

  const {
    result: visualization,
    responseData,
    recordedTarget,
  } = buildInteractionResponseData({
    source: { kind: 'runtime', result },
    referenceFrame: undefined,
  });
  // The construction site routes node/tree onto the typed recordedTarget
  // channel only; neither serialized payload carries them.
  assert.equal(recordedTarget?.node.ref, 'e1');
  for (const payload of [visualization, responseData]) {
    assert.equal('node' in payload, false);
    assert.equal('preActionNodes' in payload, false);
    assert.equal('targetEvidence' in payload, false);
  }
});
