import { snapshotCliOutput } from '../../src/commands/capture/output.ts';
import { interactionCliOutputFormatters } from '../../src/commands/interaction/output.ts';
import { RESPONSE_VIEWS } from '../../src/daemon/response-views.ts';
import { normalizeError } from '../../src/kernel/errors.ts';
import type { EconomySample } from './economy-metrics.ts';
import {
  ACTIONABLE_ERROR,
  NOT_SETTLED_RESULT,
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

export function renderOutputFixtures() {
  const snapshot = snapshotCliOutput({
    result: SNAPSHOT_RESULT,
  });
  const snapshotDigest = RESPONSE_VIEWS.snapshot!(SNAPSHOT_DAEMON_RESULT, 'digest');
  const settleDigest = RESPONSE_VIEWS.press!(SETTLE_ADDED_REF_RESULT, 'digest');
  const settleTailDigest = RESPONSE_VIEWS.press!(SETTLE_TAIL_RESULT, 'digest');
  const selectorDigest = RESPONSE_VIEWS.find!(SELECTOR_READ_RESULT, 'digest');
  const screenshotDigest = RESPONSE_VIEWS.screenshot!(SCREENSHOT_RESULT, 'digest');
  const error = normalizeError(ACTIONABLE_ERROR);

  return {
    snapshot,
    snapshotDigest,
    settleDigest,
    settleTailDigest,
    selectorDigest,
    screenshotDigest,
    error,
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
      'screenshot.default.json': { data: SCREENSHOT_RESULT },
      'screenshot.digest.json': { data: screenshotDigest },
      'error.normalized.json': { data: error },
    } satisfies Record<string, EconomySample>,
  };
}
