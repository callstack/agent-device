import type {
  SnapshotNode,
  SnapshotPreferredBackend,
  SnapshotQualityVerdict,
} from '@agent-device/kernel/snapshot';
import { isViewportRootNode } from '@agent-device/contracts/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { now, sleep } from '../../runtime-common.ts';
import {
  captureSelectorSnapshot,
  type CapturedSnapshot,
  type SelectorSnapshotOptions,
} from './selector-read-shared.ts';
import { runWithinWaitDeadline } from './wait-deadline.ts';
import {
  stableCaptureSignal,
  stableCaptureSignalsHaveBroadReplacement,
  stableCaptureSignalsEqual,
  type StableCaptureSignal,
} from './stable-capture-signal.ts';
import { preferredSnapshotBackendForVerdict } from '@agent-device/capture-kit/snapshot-quality-verdict';

/**
 * The quiet-window stable-capture loop shared by `wait stable` and the
 * interaction `--settle` flag (#1101): capture the interactive-only tree,
 * digest it, and declare the UI stable once at least two captures in a row
 * stay identical for `quietMs`. The loop itself never throws and never
 * updates the session snapshot — callers map the outcome to their own
 * semantics (`wait stable` throws on timeout; `--settle` is best-effort and
 * reports `settled: false`).
 */

const STABLE_POLL_INTERVAL_MS = 300;
const STABLE_MIN_POLL_MS = 25;
// Wake PAST the quiet deadline rather than exactly on it. `setTimeout(n)` can
// advance `Date.now()` by only n-1 — libuv times the sleep on the monotonic
// loop clock while `now()` reads the wall clock — so a capture landing on the
// deadline decides `settled` by sub-millisecond skew rather than by the UI.
const QUIET_DEADLINE_EPSILON_MS = 2;
// Broad replacements (for example, dismissing a modal into a room) can expose a coherent but
// transitional AX tree for the default quiet window. Confirm those transitions longer without
// adding latency to local mutations whose pre/post trees substantially overlap.
const BROAD_TRANSITION_CONFIRMATION_QUIET_MS = 1_500;
export const DEFAULT_STABLE_QUIET_MS = 500;
export const DEFAULT_STABLE_TIMEOUT_MS = 10_000;
// Below this node count a settled tree is suspicious: real app surfaces have
// more than a handful of accessibility nodes, splash/loading screens do not.
export const TINY_STABLE_TREE_NODE_COUNT = 5;
// A settled-but-tiny tree usually means a splash/loading surface, not real
// content: stability alone is a weak readiness signal there.
export const TINY_STABLE_TREE_HINT =
  'Settled on a nearly-empty tree — the app may still be loading. Wait for specific content (wait text ...) before interacting.';

export type StableCaptureLoopResult = {
  /** Two identical captures held the quiet window before the deadline. */
  settled: boolean;
  /** A capture stalled past the remaining deadline (no verdict available). */
  stalled: boolean;
  waitedMs: number;
  captures: number;
  nodeCount: number;
  /** The most recent completed capture, settled or not. */
  lastCapture?: CapturedSnapshot;
};

export async function runStableCaptureLoop(
  runtime: AgentDeviceRuntime,
  options: CommandContext & SelectorSnapshotOptions,
  params: {
    quietMs: number;
    timeoutMs: number;
    resetBudgetOnPrivateAxRecovery?: boolean;
    /** Immutable pre-action projection; the stored session may advance before settle begins. */
    broadTransitionBaselineNodes?: SnapshotNode[];
  },
): Promise<StableCaptureLoopResult> {
  const { quietMs, timeoutMs } = params;
  const start = now(runtime);
  let deadlineMs = start + timeoutMs;
  let privateAxRecoveryBudgetReset = false;
  const session = await runtime.sessions.get(options.session ?? 'default');
  let transitionBaseline: StableCaptureSignal | undefined;
  let preferredBackend = preferredSnapshotBackendForVerdict(session?.snapshot?.snapshotQuality);
  // Cadence derives from the quiet window (never slower than the default
  // poll): a caller asking for a 50ms quiet window should not be forced onto a
  // 300ms grid — and tests inject the budget instead of waiting real time.
  const pollMs = Math.min(STABLE_POLL_INTERVAL_MS, Math.max(STABLE_MIN_POLL_MS, quietMs));
  let captures = 0;
  let lastSignal: StableCaptureSignal | undefined;
  let lastNodeCount = 0;
  let lastCapture: CapturedSnapshot | undefined;
  let quietSinceMs = start;
  let requiredQuietMs = quietMs;
  while (now(runtime) < deadlineMs) {
    const capture = await captureStableSignalWithinDeadline(
      runtime,
      options,
      deadlineMs - now(runtime),
      preferredBackend,
    );
    if (!capture) {
      return {
        settled: false,
        stalled: true,
        waitedMs: now(runtime) - start,
        captures,
        nodeCount: lastNodeCount,
        lastCapture,
      };
    }
    captures += 1;
    lastCapture = capture;
    transitionBaseline ??= stableCaptureTransitionBaseline(
      params.broadTransitionBaselineNodes,
      capture.snapshot,
      runtime.backend.platform,
    );
    const signal = stableCaptureSignal(capture.snapshot);
    requiredQuietMs = stableCaptureTransitionQuietMs({
      baseline: transitionBaseline,
      signal,
      requestedQuietMs: quietMs,
      currentQuietMs: requiredQuietMs,
    });
    preferredBackend ??= preferredSnapshotBackendForVerdict(capture.snapshot.snapshotQuality);
    const nowMs = now(runtime);
    const recoveredDeadlineMs = extendedDeadlineAfterPrivateAxRecovery({
      resetRequested: params.resetBudgetOnPrivateAxRecovery,
      alreadyReset: privateAxRecoveryBudgetReset,
      verdict: capture.snapshot.snapshotQuality,
      nowMs,
      timeoutMs,
      deadlineMs,
    });
    if (recoveredDeadlineMs !== undefined) {
      privateAxRecoveryBudgetReset = true;
      deadlineMs = recoveredDeadlineMs;
      quietSinceMs = nowMs;
      lastSignal = signal;
      lastNodeCount = capture.snapshot.nodes.length;
      const recoveryDelayMs = stableCaptureDelayMs({
        nowMs,
        quietSinceMs,
        quietMs: requiredQuietMs,
        pollMs,
        deadlineMs,
      });
      if (recoveryDelayMs <= 0) break;
      await sleep(runtime, recoveryDelayMs);
      continue;
    }
    if (!stableCaptureSignalsEqual(lastSignal, signal)) {
      lastSignal = signal;
      lastNodeCount = capture.snapshot.nodes.length;
      quietSinceMs = nowMs;
    } else if (captures >= 2 && nowMs - quietSinceMs >= requiredQuietMs) {
      return {
        settled: true,
        stalled: false,
        waitedMs: nowMs - start,
        captures,
        nodeCount: lastNodeCount,
        lastCapture,
      };
    }
    const delayMs = stableCaptureDelayMs({
      nowMs,
      quietSinceMs,
      quietMs: requiredQuietMs,
      pollMs,
      deadlineMs,
    });
    if (delayMs <= 0) break;
    await sleep(runtime, delayMs);
  }
  return {
    settled: false,
    stalled: false,
    waitedMs: now(runtime) - start,
    captures,
    nodeCount: lastNodeCount,
    lastCapture,
  };
}

function stableCaptureTransitionBaseline(
  baselineNodes: SnapshotNode[] | undefined,
  snapshot: Parameters<typeof stableCaptureSignal>[0] | undefined,
  platform: AgentDeviceRuntime['backend']['platform'],
): StableCaptureSignal | undefined {
  // SnapshotState.backend is optional at the runtime boundary. The bound iOS backend remains
  // authoritative when a presented capture omits that provenance; a declared non-XCTest backend
  // still wins so this confirmation cannot leak onto another capture implementation.
  if (!baselineNodes || !snapshot || !isBoundIosXCTestCapture(snapshot.backend, platform)) {
    return undefined;
  }
  // A broad *screen* replacement needs a complete post-action viewport projection. The baseline
  // comes from settle's authoritative pre-action capture, but a presented iOS modal can omit its
  // Application root and still be the complete interaction surface. Requiring the root only from
  // the candidate prevents scoped/synthetic post-action fragments from extending settle latency.
  const hasCompleteViewportProjection = snapshot.nodes.some(isViewportRootNode);
  // Tiny pre-action surfaces are the other trustworthy completeness signal: iOS presents alerts
  // and sheets as a handful of nodes, and their first post-dismissal capture can temporarily omit
  // the viewport root. Treating that rootless replacement as an arbitrary scoped projection lets
  // a coherent transitional tree win the default 500ms quiet window.
  const hasTinyPresentedBaseline = baselineNodes.length <= TINY_STABLE_TREE_NODE_COUNT;
  if (!hasCompleteViewportProjection && !hasTinyPresentedBaseline) return undefined;
  return stableCaptureSignal({ ...snapshot, nodes: baselineNodes });
}

function isBoundIosXCTestCapture(
  backend: Parameters<typeof stableCaptureSignal>[0]['backend'],
  platform: AgentDeviceRuntime['backend']['platform'],
): boolean {
  if (backend === 'xctest') return true;
  return backend === undefined && platform === 'ios';
}

function stableCaptureTransitionQuietMs(params: {
  baseline: StableCaptureSignal | undefined;
  signal: StableCaptureSignal;
  requestedQuietMs: number;
  currentQuietMs: number;
}): number {
  if (
    params.requestedQuietMs < DEFAULT_STABLE_QUIET_MS ||
    !stableCaptureSignalsHaveBroadReplacement(params.baseline, params.signal)
  ) {
    return params.currentQuietMs;
  }
  return Math.max(params.requestedQuietMs, BROAD_TRANSITION_CONFIRMATION_QUIET_MS);
}

function isPrivateAxRecovery(verdict: SnapshotQualityVerdict | undefined): boolean {
  // 'deferred' = the penalty circuit breaker routed straight to private AX; the capture paid no
  // grind, so there is nothing to give the settle budget back for.
  return (
    verdict?.state === 'recovered' &&
    verdict.backend === 'private-ax' &&
    verdict.reasonCode !== 'deferred'
  );
}

function extendedDeadlineAfterPrivateAxRecovery(params: {
  resetRequested: boolean | undefined;
  alreadyReset: boolean;
  verdict: SnapshotQualityVerdict | undefined;
  nowMs: number;
  timeoutMs: number;
  deadlineMs: number;
}): number | undefined {
  if (
    params.resetRequested !== true ||
    params.alreadyReset ||
    !isPrivateAxRecovery(params.verdict)
  ) {
    return undefined;
  }
  return Math.max(params.deadlineMs, params.nowMs + params.timeoutMs);
}

/**
 * How long to wait before the next capture, or 0 when there is no wait worth
 * taking and the loop should stop.
 *
 * While the quiet deadline is still further away than one poll, keep the
 * cadence so a change is noticed promptly. Once it is within reach, sleep to
 * just past it instead — the capture that decides `settled` then always spans
 * the window, rather than landing on the boundary where clock skew picks the
 * answer (#1306).
 *
 * The loop only runs again while `now < deadline`. Normally the wake-up must
 * land strictly inside the budget to leave room for another capture. At the
 * final skew-sized boundary, however, requesting the full remaining budget is
 * useful: an exact clock lands on the deadline and exits, while an undershooting
 * clock advances inside the deadline and gets the settling capture. Never
 * request less than the epsilon — a 1ms sleep can advance the wall clock by 0
 * and spin forever under the skew this function exists to absorb.
 */
function stableCaptureDelayMs(params: {
  nowMs: number;
  quietSinceMs: number;
  quietMs: number;
  pollMs: number;
  deadlineMs: number;
}): number {
  const remainingQuietMs = params.quietSinceMs + params.quietMs - params.nowMs;
  const cadenceMs =
    remainingQuietMs > params.pollMs
      ? params.pollMs
      : Math.max(STABLE_MIN_POLL_MS, remainingQuietMs + QUIET_DEADLINE_EPSILON_MS);
  const remainingBudgetMs = params.deadlineMs - params.nowMs;
  const lastUsefulWakeMs = remainingBudgetMs - 1;
  if (lastUsefulWakeMs < QUIET_DEADLINE_EPSILON_MS) {
    return remainingBudgetMs >= QUIET_DEADLINE_EPSILON_MS ? remainingBudgetMs : 0;
  }
  return Math.min(cadenceMs, lastUsefulWakeMs);
}

// Intentionally does not update the session snapshot: the stable loop captures
// an interactive-only tree purely as a settle signal, and overwriting the
// session's richer cached snapshot with the filtered tree would degrade
// subsequent ref/get/find lookups against the same session. (`--settle` DOES
// store its final capture, but explicitly, in one place, after the loop.)
//
// Resolves undefined when the capture does not return within remainingMs. A
// stalled backend capture (observed with macOS AX captures) must not push the
// stable wait past the user-supplied timeout into the daemon request timeout.
// The deadline cancels and joins the capture before returning so no late capture
// can overwrite session state or retain a platform helper.
async function captureStableSignalWithinDeadline(
  runtime: AgentDeviceRuntime,
  options: CommandContext & SelectorSnapshotOptions,
  remainingMs: number,
  preferredBackend?: SnapshotPreferredBackend,
): Promise<CapturedSnapshot | undefined> {
  const result = await runWithinWaitDeadline(runtime, options, remainingMs, async (signal) => {
    return await captureSelectorSnapshot(
      runtime,
      { ...options, signal },
      {
        updateSession: false,
        interactiveOnly: true,
        preferredBackend,
      },
    );
  });
  return result.timedOut ? undefined : result.value;
}
