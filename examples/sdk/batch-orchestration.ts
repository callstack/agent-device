/**
 * Batch orchestration for a custom transport: `runBatch` keeps step
 * validation, inherited flags, serial execution, partial results, and
 * daemon-shaped error envelopes aligned with the CLI's `batch` command, so a
 * bridge that owns command dispatch itself does not have to reimplement them.
 *
 * Demonstrates: `runBatch` from `agent-device/batch`, consumed against the
 * `DaemonResponse` result type from `agent-device/contracts`.
 *
 * Prerequisites: none — `dispatch` below is a stub; a real integration would
 * replace it with a call into the bridge's own command dispatcher.
 *
 * Run: node --experimental-strip-types examples/sdk/batch-orchestration.ts
 */
import { runBatch } from 'agent-device/batch';
import type { DaemonResponse } from 'agent-device/contracts';

type BatchRequest = Parameters<typeof runBatch>[0];

async function dispatch(stepReq: unknown): Promise<Record<string, unknown>> {
  console.log('dispatching step', stepReq);
  return { handled: true };
}

function bridgeErrorToDaemonResponse(error: unknown): Extract<DaemonResponse, { ok: false }> {
  return {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: error instanceof Error ? error.message : 'Unknown bridge error',
    },
  };
}

async function handleBatch(req: BatchRequest): Promise<DaemonResponse> {
  return await runBatch(req, req.session ?? 'default', async (stepReq) => {
    try {
      return { ok: true, data: await dispatch(stepReq) };
    } catch (error) {
      return bridgeErrorToDaemonResponse(error);
    }
  });
}

const result = await handleBatch({
  command: 'batch',
  positionals: [],
  flags: {
    batchSteps: [
      { command: 'wait', input: { text: 'Welcome' } },
      { command: 'back', input: {} },
    ],
  },
});

if (result.ok) {
  console.log(`batch completed: ${JSON.stringify(result.data)}`);
} else {
  console.error(`batch failed [${result.error.code}]: ${result.error.message}`);
  process.exitCode = 1;
}
