import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import { AppError } from '../../../src/kernel/errors.ts';
import { assertRpcError, assertRpcOk } from '../provider-scenarios/assertions.ts';
import { scenarioName } from './coverage-manifest.ts';
import { MAESTRO_FALLBACK_COVERAGE } from './maestro-fallback.coverage.ts';
import { RUNNER_CLOSED_DRAWER_NODES } from './fixtures.ts';
import {
  runnerSnapshotEntry,
  runnerTapEntry,
  runnerTapErrorEntry,
  withIosContractDaemon,
} from './daemon-harness.ts';

// ADR 0011 Layer 3, maestro-non-hittable-fallback path: replay-only
// coordinate fallback for non-hittable elements, Maestro semantics. Path
// forcing is natural: the maestro.allowNonHittableCoordinateFallback flag on
// a simple-selector click forwards the fallback permission to the runner.

const scenario = (guarantee: InteractionGuarantee): string =>
  scenarioName(MAESTRO_FALLBACK_COVERAGE, guarantee);

const MAESTRO_FLAGS = { maestro: { allowNonHittableCoordinateFallback: true } };

test(scenario('responseConstruction'), async () => {
  await withIosContractDaemon(
    [
      runnerTapEntry({
        x: 50,
        y: 60,
        message: 'tapped via non-hittable coordinate fallback',
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
    },
  );
});

test(scenario('offscreen'), async () => {
  await withIosContractDaemon(
    [
      // hasTappableFrame refuses empty/out-of-app frames runner-side; the
      // daemon then falls back to the runtime path, which refuses with the
      // actionable offscreen shape instead of tapping blind coordinates.
      runnerTapErrorEntry(new AppError('ELEMENT_OFFSCREEN', 'Element has no tappable frame')),
      runnerSnapshotEntry(RUNNER_CLOSED_DRAWER_NODES),
    ],
    async (daemon) => {
      const click = await daemon.callCommand('click', ['label=Explore'], MAESTRO_FLAGS);
      const error = assertRpcError(
        click,
        'COMMAND_FAILED',
        /off-screen element and is not safe to click/,
      );
      const details = error.details as Record<string, unknown> | undefined;
      assert.equal(details?.reason, 'offscreen_selector');
    },
  );
});
