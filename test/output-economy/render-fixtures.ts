import { snapshotCliOutput } from '../../src/commands/capture/output.ts';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import type { AgentDeviceClient } from '../../src/client/client-types.ts';
import { normalizeError } from '@agent-device/kernel/errors';
import { createCommandToolExecutor } from '../../src/mcp/command-tools.ts';
import type { EconomySample } from './economy-metrics.ts';
import { renderRoutineWorkflow } from './routine-workflow.ts';
import { captureOutputEconomyDaemonResponses } from './daemon-route-fixtures.ts';
import {
  ACTIONABLE_ERROR,
  NOT_SETTLED_RESULT,
  POLICY_NORMALIZED_ERROR,
  SELECTOR_READ_RESULT,
  SETTLE_ADDED_REF_RESULT,
  SETTLE_TAIL_RESULT,
  SNAPSHOT_DAEMON_RESULT,
  SNAPSHOT_RESULT,
} from './fixtures.ts';
import {
  DEBUG_SELECTION_RESULT,
  EVENTS_SELECTION_RESULT,
  NETWORK_SELECTION_RESULT,
  RECORDING_SELECTION_RESULT,
} from './selection-fixtures.ts';

function interactionText(result: Record<string, unknown>): string {
  return interactionCliOutputFormatters.press({ input: {}, result }).text ?? '';
}

export async function renderOutputFixtures() {
  const daemon = await captureOutputEconomyDaemonResponses();
  const snapshot = await snapshotCliOutput({
    result: SNAPSHOT_RESULT,
  });
  const error = normalizeError(ACTIONABLE_ERROR);
  const errorPolicyNormalized = normalizeError(POLICY_NORMALIZED_ERROR);
  const mcpSnapshot = await createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => SNAPSHOT_DAEMON_RESULT,
  }).execute('snapshot', {});
  const workflow = await renderRoutineWorkflow();

  return {
    snapshot,
    daemonSnapshotDefault: daemon.snapshotDefault,
    snapshotDigest: daemon.snapshotDigest,
    settleDigest: daemon.settleDigest,
    settleTailDigest: daemon.settleTailDigest,
    settleDefault: daemon.settleDefault,
    settleTailDefault: daemon.settleTailDefault,
    postOrderSnapshotDefault: daemon.postOrderSnapshotDefault,
    postOrderSnapshotDigest: daemon.postOrderSnapshotDigest,
    snapshotDigestBeforeSettle: daemon.snapshotDigestBeforeSettle,
    selectorDigest: daemon.selectorDigest,
    screenshotDefault: daemon.screenshotDefault,
    screenshotDigest: daemon.screenshotDigest,
    networkDigest: daemon.networkDigest,
    error,
    errorPolicyNormalized,
    mcpSnapshot,
    samples: {
      'snapshot.default.text': { text: snapshot.text ?? '' },
      'snapshot.default.json': { data: snapshot.jsonData },
      'snapshot.digest.json': { data: daemon.snapshotDigest },
      'settle.default.text': { text: interactionText(SETTLE_ADDED_REF_RESULT) },
      'settle.default.json': { data: SETTLE_ADDED_REF_RESULT },
      'settle.digest.json': { data: daemon.settleDigest },
      'settle-tail.default.text': { text: interactionText(SETTLE_TAIL_RESULT) },
      'settle-tail.digest.json': { data: daemon.settleTailDigest },
      'not-settled.default.text': { text: interactionText(NOT_SETTLED_RESULT) },
      'selector-read.default.json': { data: SELECTOR_READ_RESULT },
      'selector-read.digest.json': { data: daemon.selectorDigest },
      'screenshot.default.json': { data: daemon.screenshotDefault },
      'screenshot.digest.json': { data: daemon.screenshotDigest },
      'error.normalized.json': { data: error },
      'error.policy-normalized.json': { data: errorPolicyNormalized },
      'mcp.snapshot.default.json': { data: mcpSnapshot },
      'selection.network.default.json': { data: NETWORK_SELECTION_RESULT },
      'selection.network.digest.json': { data: daemon.networkDigest },
      'selection.events.default.json': { data: EVENTS_SELECTION_RESULT },
      'selection.debug.default.json': { data: DEBUG_SELECTION_RESULT },
      'selection.recording.default.json': { data: RECORDING_SELECTION_RESULT },
      ...workflow.samples,
    } satisfies Record<string, EconomySample>,
  };
}
