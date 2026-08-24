import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import { assertRpcError, assertRpcOk } from '../provider-scenarios/assertions.ts';
import { PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS } from '../provider-scenarios/test-timeouts.ts';
import { scenarioName } from './coverage-manifest.ts';
import { RUNNER_CONTINUE_NODES, RUNNER_NON_HITTABLE_TEXT_INPUT_NODES } from './fixtures.ts';
import { MAESTRO_FALLBACK_COVERAGE } from './maestro-fallback.coverage.ts';
import {
  runnerSnapshotEntry,
  runnerTapEntry,
  runnerTapErrorEntry,
  runnerTypeEntry,
  withIosContractDaemon,
} from './daemon-harness.ts';

// ADR 0011 Layer 3, maestro-non-hittable-fallback path: replay-only
// coordinate fallback for non-hittable elements, Maestro semantics. Path
// forcing is natural: the maestro.allowNonHittableCoordinateFallback flag on
// a simple-selector click forwards the fallback permission to the runner. The
// fill compatibility case below intentionally proves the surviving runtime
// route instead, so removal of direct selector fill cannot erase that coverage.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(MAESTRO_FALLBACK_COVERAGE, guarantee);

const MAESTRO_FLAGS = { maestro: { allowNonHittableCoordinateFallback: true } };

test(
  scenario('responseConstruction'),
  async () => {
    await withIosContractDaemon(
      [
        runnerTapEntry({
          x: 50,
          y: 60,
          message: 'tapped via non-hittable coordinate fallback',
          maestroNonHittableCoordinateFallbackUsed: true,
        }),
      ],
      async (daemon, transcript) => {
        const click = await daemon.callCommand('click', ['label=Pin'], MAESTRO_FLAGS);
        const data = assertRpcOk(click);

        // The runner received the fallback permission on the selector tap.
        const tapRequest = transcript.calls[0]?.request as Record<string, unknown> | undefined;
        assert.equal(tapRequest?.selectorValue, 'Pin');
        assert.equal(tapRequest?.allowNonHittableCoordinateFallback, true);

        // Canonical field set plus the fallback markers the replay layer keys on.
        assert.equal(data.x, 50);
        assert.equal(data.y, 60);
        assert.equal(data.selector, 'label=Pin');
        assert.equal(data.maestroNonHittableCoordinateFallbackAllowed, true);
        assert.equal(data.maestroNonHittableCoordinateFallbackUsed, true);
        assert.equal(data.maestroFallbackReason, 'non-hittable-coordinate');
        // Fallback actually TAKEN: the inapplicable maestro cell, no resolution field.
        assert.equal(data.resolution, undefined);
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);

// The fourth cell of the resolution-suppression matrix. Runner-payload/taken
// and runtime/taken are covered here; runner-payload/not-taken belongs to the
// sibling maestro-direct-selector contract. Suppression is keyed on the
// dispatch that RAN — a runtime fill the fallback never touched still
// discloses how the daemon resolved it, whether or not the request carried the
// Maestro permission.
test('runtime fill the coordinate fallback did not execute keeps its resolution disclosure', async () => {
  await withIosContractDaemon(
    [runnerSnapshotEntry(RUNNER_CONTINUE_NODES), runnerTypeEntry({ x: 200, y: 322 })],
    async (daemon) => {
      const data = assertRpcOk(
        await daemon.callCommand('fill', ['label=Continue', '1234'], MAESTRO_FLAGS),
      );

      assert.equal(data.maestroNonHittableCoordinateFallbackAllowed, true);
      assert.equal(data.maestroNonHittableCoordinateFallbackUsed, false);
      assert.deepEqual(data.resolution, {
        source: 'runtime',
        phase: 'pre-action',
        kind: 'unique',
      });
    },
  );
});

test('Maestro fill of a non-hittable input resolves through the runtime path', async () => {
  await withIosContractDaemon(
    [
      runnerSnapshotEntry(RUNNER_NON_HITTABLE_TEXT_INPUT_NODES),
      runnerTypeEntry({
        x: 100,
        y: 60,
        maestroNonHittableCoordinateFallbackUsed: true,
      }),
    ],
    async (daemon, transcript) => {
      const data = assertRpcOk(
        await daemon.callCommand('fill', ['label=Pin', '1234'], MAESTRO_FLAGS),
      );

      assert.equal(transcript.calls[0]?.command, 'ios.runner.snapshot');
      assert.equal(transcript.calls[1]?.command, 'ios.runner.type');
      const typeRequest = transcript.calls[1]?.request as Record<string, unknown> | undefined;
      assert.equal(typeRequest?.selectorKey, undefined);
      assert.equal(typeRequest?.x, 100);
      assert.equal(typeRequest?.y, 60);
      assert.equal(typeRequest?.allowNonHittableCoordinateFallback, true);
      assert.equal(data.resolution, undefined);
      assert.equal(data.targetHittable, false);
      assert.equal(data.maestroNonHittableCoordinateFallbackAllowed, true);
      assert.equal(data.maestroNonHittableCoordinateFallbackUsed, true);
      assert.equal(data.maestroFallbackReason, 'non-hittable-coordinate');
    },
  );
});

test(
  scenario('offscreen'),
  async () => {
    await withIosContractDaemon(
      [
        // The runner refuses empty/out-of-app frames. Maestro replay preserves
        // this typed result so the compat runtime can own fresh-geometry fallback.
        runnerTapErrorEntry(new AppError('ELEMENT_OFFSCREEN', 'Element has no tappable frame')),
      ],
      async (daemon) => {
        const click = await daemon.callCommand('click', ['label=Explore'], MAESTRO_FLAGS);
        assertRpcError(click, 'ELEMENT_OFFSCREEN', /no tappable frame/);
      },
    );
  },
  PARALLEL_PROVIDER_SCENARIO_TIMEOUT_MS,
);
