import { snapshotCliOutput } from '../../src/commands/capture/output.ts';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import type { AgentDeviceClient } from '../../src/client/client-types.ts';
import { RESPONSE_VIEWS } from '../../src/daemon/response-views.ts';
import { normalizeError } from '../../src/kernel/errors.ts';
import { createCommandToolExecutor } from '../../src/mcp/command-tools.ts';
import type { EconomySample } from './economy-metrics.ts';
import { renderRoutineWorkflow } from './routine-workflow.ts';
import {
  ACTIONABLE_ERROR,
  NOT_SETTLED_RESULT,
  POLICY_NORMALIZED_ERROR,
  SCREENSHOT_RESULT,
  SELECTOR_READ_RESULT,
  SETTLE_ADDED_REF_RESULT,
  SETTLE_TAIL_RESULT,
  SNAPSHOT_DAEMON_RESULT,
  SNAPSHOT_RESULT,
} from './fixtures.ts';

function interactionText(result: typeof SETTLE_ADDED_REF_RESULT): string {
  return interactionCliOutputFormatters.press({ input: {}, result }).text ?? '';
}

export async function renderOutputFixtures() {
  const snapshot = snapshotCliOutput({
    result: SNAPSHOT_RESULT,
  });
  const snapshotDigest = RESPONSE_VIEWS.snapshot!(SNAPSHOT_DAEMON_RESULT, 'digest');
  const settleDigest = RESPONSE_VIEWS.press!(SETTLE_ADDED_REF_RESULT, 'digest');
  const settleTailDigest = RESPONSE_VIEWS.press!(SETTLE_TAIL_RESULT, 'digest');
  const selectorDigest = RESPONSE_VIEWS.find!(SELECTOR_READ_RESULT, 'digest');
  const screenshotDefault = RESPONSE_VIEWS.screenshot!(SCREENSHOT_RESULT, 'default');
  const screenshotDigest = RESPONSE_VIEWS.screenshot!(SCREENSHOT_RESULT, 'digest');
  const error = normalizeError(ACTIONABLE_ERROR);
  const errorPolicyNormalized = normalizeError(POLICY_NORMALIZED_ERROR);
  const mcpSnapshot = await createCommandToolExecutor({
    createClient: () => ({}) as AgentDeviceClient,
    runCommand: async () => SNAPSHOT_DAEMON_RESULT,
  }).execute('snapshot', {});
  const workflow = await renderRoutineWorkflow();

  return {
    snapshot,
    snapshotDigest,
    settleDigest,
    settleTailDigest,
    selectorDigest,
    screenshotDefault,
    screenshotDigest,
    error,
    errorPolicyNormalized,
    mcpSnapshot,
    samples: {
      'snapshot.default.text': { text: snapshot.text ?? '' },
      'snapshot.default.json': { data: snapshot.jsonData },
      'snapshot.digest.json': { data: snapshotDigest },
      'settle.default.text': { text: interactionText(SETTLE_ADDED_REF_RESULT) },
      'settle.default.json': { data: SETTLE_ADDED_REF_RESULT },
      'settle.digest.json': { data: settleDigest },
      'settle-tail.default.text': { text: interactionText(SETTLE_TAIL_RESULT) },
      'settle-tail.digest.json': { data: settleTailDigest },
      'not-settled.default.text': { text: interactionText(NOT_SETTLED_RESULT) },
      'selector-read.default.json': { data: SELECTOR_READ_RESULT },
      'selector-read.digest.json': { data: selectorDigest },
      'screenshot.default.json': { data: screenshotDefault },
      'screenshot.digest.json': { data: screenshotDigest },
      'error.normalized.json': { data: error },
      'error.policy-normalized.json': { data: errorPolicyNormalized },
      'mcp.snapshot.default.json': { data: mcpSnapshot },
      ...workflow.samples,
    } satisfies Record<string, EconomySample>,
  };
}
