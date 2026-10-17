import { test } from 'vitest';
import { PROVIDER_SCENARIO_ANDROID } from './fixtures.ts';
import { assertRpcError } from './assertions.ts';
import { createProviderScenarioHarness, withProviderScenarioResource } from './harness.ts';

test('Provider-backed integration batch rejects boundary flag values through the daemon path', async () => {
  await withProviderScenarioResource(
    async () =>
      await createProviderScenarioHarness({
        deviceInventoryProvider: async () => [PROVIDER_SCENARIO_ANDROID],
      }),
    async (daemon) => {
      const unsupportedOnError = await daemon.callCommand('batch', [], {
        batchOnError: 'continue' as never,
        batchSteps: [{ command: 'wait', positionals: ['1'] }],
      });
      assertRpcError(unsupportedOnError, 400, 'INVALID_ARGS', /Unsupported batch on-error mode/);

      const invalidMaxSteps = await daemon.callCommand('batch', [], {
        batchMaxSteps: 0,
        batchSteps: [{ command: 'wait', positionals: ['1'] }],
      });
      assertRpcError(invalidMaxSteps, 400, 'INVALID_ARGS', /Invalid batch max-steps: 0/);

      const nonIntegerMaxSteps = await daemon.callCommand('batch', [], {
        batchMaxSteps: 1.5,
        batchSteps: [{ command: 'wait', positionals: ['1'] }],
      });
      assertRpcError(nonIntegerMaxSteps, 400, 'INVALID_ARGS', /Invalid batch max-steps: 1\.5/);

      const exceedsMaxSteps = await daemon.callCommand('batch', [], {
        batchMaxSteps: 1,
        batchSteps: [
          { command: 'wait', positionals: ['1'] },
          { command: 'wait', positionals: ['1'] },
        ],
      });
      assertRpcError(exceedsMaxSteps, 400, 'INVALID_ARGS', /batch has 2 steps; max allowed is 1/);
    },
  );
});
