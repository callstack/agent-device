import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { InteractionGuarantee } from '../../../src/contracts/interaction-guarantees.ts';
import { AppError } from '../../../src/kernel/errors.ts';
import { assertRpcError, assertRpcOk } from '../provider-scenarios/assertions.ts';
import { scenarioName } from './coverage-manifest.ts';
import { MAESTRO_FALLBACK_COVERAGE } from './maestro-fallback.coverage.ts';
import {
  runnerTapEntry,
  runnerTapErrorEntry,
  runnerTypeEntry,
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
});

// Permission is not usage: with the fallback allowed but the runner hitting
// the element normally ("tapped"), the dispatch is the direct-ios path and
// must disclose not-observed, not classify as the maestro-fallback cell.
test('maestro-non-hittable-fallback resolutionDisclosure: allowed-but-not-taken discloses direct-ios not-observed', async () => {
  await withIosContractDaemon(
    [runnerTapEntry({ x: 50, y: 60, message: 'tapped' })],
    async (daemon, transcript) => {
      const click = await daemon.callCommand('click', ['label=Pin'], MAESTRO_FLAGS);
      const data = assertRpcOk(click);

      const tapRequest = transcript.calls[0]?.request as Record<string, unknown> | undefined;
      assert.equal(tapRequest?.allowNonHittableCoordinateFallback, true);

      assert.equal(data.maestroNonHittableCoordinateFallbackAllowed, true);
      assert.equal(data.maestroNonHittableCoordinateFallbackUsed, false);
      assert.deepEqual(data.resolution, { source: 'direct-ios', kind: 'not-observed' });
    },
  );
});

test('maestro-non-hittable-fallback fill resolutionDisclosure: allowed-and-taken omits resolution', async () => {
  await withIosContractDaemon(
    [
      runnerTypeEntry({
        message: 'typed',
        x: 50,
        y: 60,
        maestroNonHittableCoordinateFallbackUsed: true,
      }),
    ],
    async (daemon, transcript) => {
      const fill = await daemon.callCommand('fill', ['label=Pin', '1234'], MAESTRO_FLAGS);
      const data = assertRpcOk(fill);

      const typeRequest = transcript.calls[0]?.request as Record<string, unknown> | undefined;
      assert.equal(typeRequest?.selectorValue, 'Pin');
      assert.equal(typeRequest?.allowNonHittableCoordinateFallback, true);

      assert.equal(data.maestroNonHittableCoordinateFallbackAllowed, true);
      assert.equal(data.maestroNonHittableCoordinateFallbackUsed, true);
      assert.equal(data.maestroFallbackReason, 'non-hittable-coordinate');
      assert.equal(data.resolution, undefined);
    },
  );
});

test('maestro-non-hittable-fallback fill resolutionDisclosure: allowed-but-not-taken discloses direct-ios not-observed', async () => {
  await withIosContractDaemon(
    [
      runnerTypeEntry({
        message: 'typed after repair',
        x: 50,
        y: 60,
        maestroNonHittableCoordinateFallbackUsed: false,
      }),
    ],
    async (daemon, transcript) => {
      const fill = await daemon.callCommand('fill', ['label=Pin', '1234'], MAESTRO_FLAGS);
      const data = assertRpcOk(fill);

      const typeRequest = transcript.calls[0]?.request as Record<string, unknown> | undefined;
      assert.equal(typeRequest?.selectorValue, 'Pin');
      assert.equal(typeRequest?.allowNonHittableCoordinateFallback, true);

      assert.equal(data.maestroNonHittableCoordinateFallbackAllowed, true);
      assert.equal(data.maestroNonHittableCoordinateFallbackUsed, false);
      assert.deepEqual(data.resolution, { source: 'direct-ios', kind: 'not-observed' });
    },
  );
});

test(scenario('offscreen'), async () => {
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
});
