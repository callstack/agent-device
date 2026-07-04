import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import { makeSnapshotState } from '../../../src/__tests__/test-utils/index.ts';
import { assertRpcError, assertRpcOk } from '../provider-scenarios/assertions.ts';
import { scenarioName } from './coverage-manifest.ts';
import { COORDINATE_COVERAGE } from './coordinate.coverage.ts';
import { viewportOnlySnapshot } from './fixtures.ts';
import { createContractDevice } from './runtime-harness.ts';
import { runnerTapEntry, runnerTapErrorEntry, withIosContractDaemon } from './daemon-harness.ts';

// ADR 0011 Layer 3, coordinate path: raw x/y tap, intentionally minimal
// semantics. Path forcing is natural: a point target never resolves nodes.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(COORDINATE_COVERAGE, guarantee);

test(scenario('offscreen'), async () => {
  const device = createContractDevice(viewportOnlySnapshot(), {
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(
    { kind: 'point', x: 500, y: 500 },
    { session: 'default' },
  );

  // Coordinate semantics: the escape hatch forwards the tap but must warn —
  // never a silent out-of-viewport no-op, never a refusal.
  assert.equal(result.kind, 'point');
  assert.match(result.warning ?? '', /outside the last-known viewport \(400x800\)/);
});

test(scenario('verifyEvidence'), async () => {
  let captureCount = 0;
  const device = createContractDevice(viewportOnlySnapshot(), {
    captureSnapshot: async () => {
      captureCount += 1;
      if (captureCount === 1) return { snapshot: viewportOnlySnapshot() };
      return { snapshot: makeSnapshotState([]) };
    },
    tap: async () => ({ ok: true }),
  });

  const result = await device.interactions.click(
    { kind: 'point', x: 10, y: 20 },
    { session: 'default', verify: true },
  );

  assert.equal(result.kind, 'point');
  assert.ok(result.evidence);
  assert.equal(result.evidence?.changedFromBefore, true);
});

test(scenario('errorTaxonomy'), async () => {
  await withIosContractDaemon(
    [runnerTapErrorEntry(new Error('runner tap crashed'))],
    async (daemon) => {
      const press = await daemon.callCommand('press', ['100', '200']);
      // An unclassified backend failure gets the shared fallback classification
      // from normalizeError: stable code, original message, actionable hint.
      const error = assertRpcError(press, 'UNKNOWN', /runner tap crashed/);
      assert.ok(typeof error.hint === 'string' && error.hint.length > 0);
      assert.ok(typeof error.diagnosticId === 'string');
    },
  );
});

test(scenario('responseConstruction'), async () => {
  await withIosContractDaemon([runnerTapEntry({ x: 100, y: 200 })], async (daemon) => {
    const press = await daemon.callCommand('press', ['100', '200']);
    const data = assertRpcOk(press);
    // Canonical point response set: the tapped coordinates, no fabricated
    // identity fields (the path has no resolved node by design).
    assert.equal(data.x, 100);
    assert.equal(data.y, 200);
    assert.equal(data.ref, undefined);
    assert.equal(data.selector, undefined);
  });
});
