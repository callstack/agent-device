import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertRpcOk } from '../provider-scenarios/assertions.ts';
import { runnerTapEntry, withIosContractDaemon } from './daemon-harness.ts';
import { scenarioName } from './coverage-manifest.ts';
import { MAESTRO_DIRECT_SELECTOR_COVERAGE } from './maestro-direct-selector.coverage.ts';

const MAESTRO_FLAGS = { maestro: { allowNonHittableCoordinateFallback: true } };

// Permission is not usage: when the runner hits the element normally, the
// completed dispatch is the direct-selector path, not the coordinate fallback.
test(scenarioName(MAESTRO_DIRECT_SELECTOR_COVERAGE, 'responseConstruction'), async () => {
  await withIosContractDaemon(
    [runnerTapEntry({ x: 50, y: 60, message: 'tapped' })],
    async (daemon, transcript) => {
      const data = assertRpcOk(await daemon.callCommand('click', ['label=Pin'], MAESTRO_FLAGS));

      const tapRequest = transcript.calls[0]?.request as Record<string, unknown> | undefined;
      assert.equal(tapRequest?.allowNonHittableCoordinateFallback, true);
      assert.equal(data.maestroNonHittableCoordinateFallbackAllowed, true);
      assert.equal(data.maestroNonHittableCoordinateFallbackUsed, false);
      assert.deepEqual(data.resolution, { source: 'direct-ios', kind: 'not-observed' });
    },
  );
});
