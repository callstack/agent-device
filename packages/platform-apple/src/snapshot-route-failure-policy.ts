import type { SnapshotSourceFailure } from './snapshot-source-facade.ts';

/**
 * What the screen showed when a capture-scoped bridge refusal fired: a preparation still running
 * (#2491), an unresolved coordinate space (#2612), a foreground another surface owns (#3874), or a
 * window that does not fill the screen (#3844). The route consumes one disposition for both
 * decisions that must agree: whether the generation's bridge circuit opens, and which sentence the
 * fallback warning carries (#3874, #3895).
 */
export type CaptureScopedConsequence =
  | 'bridge-preparation'
  | 'coordinate-space-unresolved'
  | 'foreground-ownership'
  | 'window-not-full-screen';

/**
 * The one classification a bridge failure receives before the route acts on it. `code` travels
 * unchanged for diagnostics; the scope says whether the generation is implicated, and a
 * capture-scoped verdict must name what it saw instead.
 */
export type BridgeFailureDisposition =
  | Readonly<{ scope: 'capture'; code: string; consequence: CaptureScopedConsequence }>
  | Readonly<{ scope: 'generation'; code: string }>;

/**
 * Screen evidence, not app evidence: the arrangement is gone after the next keystroke, tap, or
 * resize, so retiring the generation would move every later capture of a healthy app to the runner.
 * A new capture-scoped refusal enters here, by an explicit decision; the route's warning switch is
 * exhaustive over the consequence, so a new one cannot reach the warning path undefined.
 */
const CAPTURE_SCOPED_REFUSALS = {
  'window-coordinate-space-unresolved': 'coordinate-space-unresolved',
  'app-window-not-full-screen': 'window-not-full-screen',
  'foreground-owner-unverified': 'foreground-ownership',
  'foreground-owner-changed': 'foreground-ownership',
} as const satisfies Readonly<Record<string, CaptureScopedConsequence>>;

/**
 * Whether a bridge failure is evidence that this app generation cannot be served by the bridge.
 * The preparation and the table's screen refusals speak for this capture only; every other failure
 * retires the generation. That default is conservative on purpose: `code` is an open string from
 * the guest, and an unknown code must not quietly keep a generation on a path that just refused
 * it. Do not widen the default; classify a new known refusal in the table.
 */
export function bridgeFailureDisposition(failure: SnapshotSourceFailure): BridgeFailureDisposition {
  if (failure.kind === 'preparing') {
    return { scope: 'capture', code: failure.code, consequence: 'bridge-preparation' };
  }
  const consequence = CAPTURE_SCOPED_REFUSALS[failure.code as keyof typeof CAPTURE_SCOPED_REFUSALS];
  if (consequence) {
    return { scope: 'capture', code: failure.code, consequence };
  }
  return { scope: 'generation', code: failure.code };
}
