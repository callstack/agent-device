import type {
  SnapshotNode,
  SnapshotPreferredBackend,
  SnapshotProvenance,
  SnapshotQualityVerdict,
  SnapshotState,
} from '@agent-device/kernel/snapshot';
import { isViewportRootNode } from '@agent-device/contracts/snapshot';
import type { AgentDeviceRuntime, CommandContext } from '@agent-device/contracts/runtime-contract';
import type { SurfaceScopedNodes } from '@agent-device/contracts/interaction';
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
import { withoutSettleChrome } from '@agent-device/capture-kit/snapshot-chrome';

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
// Never slower than the default poll, never faster than the minimum: a tight window gets a cadence
// that can measure it, and a window the confirmation extends is not sampled on the caller's grid.
function stableCapturePollMs(quietMs: number): number {
  return Math.min(STABLE_POLL_INTERVAL_MS, Math.max(STABLE_MIN_POLL_MS, quietMs));
}
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
/**
 * The default quiet window each producer's capture earns. The iOS simulator snapshot bridge answers
 * well inside the general default, so holding the general window on that read spends a whole extra
 * capture on a window its tree had already satisfied. Keyed on the producer, not the channel: the
 * bridge and the Apple runner share the `xctest` channel and read at different costs, and only the
 * bridge carries the measurement. Every producer states its price here, so a new one cannot inherit
 * an unmeasured window by omission. (PR #3522 holds the interleaved before/after medians and the
 * late-diff accuracy check.)
 */
const DEFAULT_QUIET_MS_BY_PRODUCER = {
  'apple-runner': DEFAULT_STABLE_QUIET_MS,
  'simulator-ax-bridge': 300,
  'appium-source': DEFAULT_STABLE_QUIET_MS,
  'limrun-ios-tree': DEFAULT_STABLE_QUIET_MS,
  'android-uiautomator': DEFAULT_STABLE_QUIET_MS,
  'harmonyos-uitest': DEFAULT_STABLE_QUIET_MS,
  'macos-helper': DEFAULT_STABLE_QUIET_MS,
  'linux-atspi': DEFAULT_STABLE_QUIET_MS,
  'agent-browser': DEFAULT_STABLE_QUIET_MS,
} as const satisfies Record<SnapshotProvenance['producer'], number>;

/** A capture that declares no producer has no measured price and keeps the general default. */
function defaultQuietMsForCapture(snapshot: SnapshotState): number {
  return snapshot.producer === undefined
    ? DEFAULT_STABLE_QUIET_MS
    : DEFAULT_QUIET_MS_BY_PRODUCER[snapshot.producer];
}
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
  /**
   * The quiet window the run was holding when it returned: the caller's, or the default resolved
   * from the last capture that paid it. A run that completed no capture never priced a window, so
   * it reports the general default it started from.
   */
  quietMs: number;
  /** The most recent completed capture, settled or not. */
  lastCapture?: CapturedSnapshot;
  /** A capture threw; the run ended there, without a verdict. */
  failure?: { error: unknown };
};

export async function runStableCaptureLoop(
  runtime: AgentDeviceRuntime,
  options: CommandContext & SelectorSnapshotOptions,
  params: {
    /**
     * The quiet window the caller asked for. Absent means the loop resolves its own default from
     * the capture it performs, because that capture is the read the window prices
     * ({@link defaultQuietMsForCapture}); a caller with its own default passes it explicitly.
     */
    quietMs?: number;
    timeoutMs: number;
    resetBudgetOnPrivateAxRecovery?: boolean;
    /** Immutable pre-action projection; the stored session may advance before settle begins. */
    broadTransitionBaseline?: SurfaceScopedNodes;
  },
): Promise<StableCaptureLoopResult> {
  const { timeoutMs } = params;
  const start = now(runtime);
  let deadlineMs = start + timeoutMs;
  let privateAxRecoveryBudgetReset = false;
  const session = await runtime.sessions.get(options.session ?? 'default');
  // The quiet window the run holds. An unrequested window is priced by the latest capture the loop
  // performs, never by the baseline's producer, and applies to the whole quiet span so far: the
  // capture that decides the verdict is the read the window prices. A producer switch mid-wait can
  // therefore shorten the window; a confirmed broad replacement never drops below its own floor.
  // A window the caller asked for is fixed.
  let quietMs = params.quietMs ?? DEFAULT_STABLE_QUIET_MS;
  const confirmation = broadTransitionConfirmation({
    baseline: params.broadTransitionBaseline,
    platform: runtime.backend.platform,
    appBundleId: session?.appBundleId,
  });
  let preferredBackend = preferredSnapshotBackendForVerdict(session?.snapshot?.snapshotQuality);
  const pacing = createStableCapturePacing(start);
  let captures = 0;
  let lastCapture: CapturedSnapshot | undefined;
  const result = (
    settled: boolean,
    stalled: boolean,
    waitedMs: number,
  ): StableCaptureLoopResult => ({
    settled,
    stalled,
    waitedMs,
    captures,
    nodeCount: pacing.lastNodeCount,
    quietMs,
    lastCapture,
  });
  const unfinished = (read: Exclude<StableCaptureRead, { kind: 'captured' }>) => ({
    ...result(false, read.kind === 'stalled', now(runtime) - start),
    ...(read.kind === 'failed' ? { failure: { error: read.error } } : {}),
  });
  while (now(runtime) < deadlineMs) {
    const read = await captureStableSignalWithinDeadline(
      runtime,
      options,
      deadlineMs - now(runtime),
      preferredBackend,
    );
    if (read.kind !== 'captured') return unfinished(read);
    const { capture } = read;
    captures += 1;
    lastCapture = capture;
    const window = stableCaptureWindow(capture.snapshot, params.quietMs, confirmation);
    quietMs = window.quietMs;
    const { requiredQuietMs, pollMs } = window;
    const signal = stableCaptureSignal(capture.snapshot);
    preferredBackend ??= preferredSnapshotBackendForVerdict(capture.snapshot.snapshotQuality);
    const nowMs = now(runtime);
    const nodeCount = capture.snapshot.nodes.length;
    const verdict = capture.snapshot.snapshotQuality;
    const recovered = recoverStableCaptureBudget({
      pacing,
      resetBudgetOnPrivateAxRecovery: params.resetBudgetOnPrivateAxRecovery,
      alreadyReset: privateAxRecoveryBudgetReset,
      state: {
        deadlineMs,
        timeoutMs,
        nowMs,
        verdict,
        signal,
        nodeCount,
        requiredQuietMs,
        pollMs,
      },
    });
    if (recovered) {
      privateAxRecoveryBudgetReset = true;
      deadlineMs = recovered.deadlineMs;
    }
    const step = recovered
      ? { settled: false, delayMs: recovered.delayMs }
      : pacing.observe({ signal, nodeCount, nowMs, requiredQuietMs, pollMs, deadlineMs, captures });
    if (step.settled) return result(true, false, nowMs - start);
    if (step.delayMs <= 0) break;
    await sleep(runtime, step.delayMs);
  }
  return result(false, false, now(runtime) - start);
}

/**
 * The quiet window one capture prices, the window it must actually hold once the broad-transition
 * confirmation has had its say, and the cadence that can measure that. Sampling an extended wait on
 * the caller's tight grid would spend the whole extension in capture round trips.
 */
function stableCaptureWindow(
  snapshot: SnapshotState,
  requestedQuietMs: number | undefined,
  confirmation: StableCaptureConfirmation,
): { quietMs: number; requiredQuietMs: number; pollMs: number } {
  const quietMs = requestedQuietMs ?? defaultQuietMsForCapture(snapshot);
  const requiredQuietMs = confirmation.requiredQuietMs(snapshot, quietMs);
  return { quietMs, requiredQuietMs, pollMs: stableCapturePollMs(requiredQuietMs) };
}

/**
 * The once-per-run budget extension a private-AX recovery buys. The recovery re-read the same
 * surface through another backend, so the quiet window restarts on that capture rather than carrying
 * suspicion across the switch. Undefined when the capture asked for no reset (or the run already
 * spent its one).
 */
function recoverStableCaptureBudget(params: {
  pacing: StableCapturePacing;
  alreadyReset: boolean;
  resetBudgetOnPrivateAxRecovery?: boolean;
  state: {
    deadlineMs: number;
    timeoutMs: number;
    nowMs: number;
    verdict: SnapshotQualityVerdict | undefined;
    signal: StableCaptureSignal;
    nodeCount: number;
    requiredQuietMs: number;
    pollMs: number;
  };
}): { deadlineMs: number; delayMs: number } | undefined {
  const { state } = params;
  const extendedDeadlineMs = extendedDeadlineAfterPrivateAxRecovery({
    resetRequested: params.resetBudgetOnPrivateAxRecovery,
    alreadyReset: params.alreadyReset,
    verdict: state.verdict,
    nowMs: state.nowMs,
    timeoutMs: state.timeoutMs,
    deadlineMs: state.deadlineMs,
  });
  if (extendedDeadlineMs === undefined) return undefined;
  params.pacing.restart({
    signal: state.signal,
    nodeCount: state.nodeCount,
    nowMs: state.nowMs,
  });
  return {
    deadlineMs: extendedDeadlineMs,
    delayMs: params.pacing.delayMs({
      nowMs: state.nowMs,
      requiredQuietMs: state.requiredQuietMs,
      pollMs: state.pollMs,
      deadlineMs: extendedDeadlineMs,
    }),
  };
}

type StableCapturePacing = ReturnType<typeof createStableCapturePacing>;

/**
 * The settle loop's per-capture bookkeeping: the last capture's shape, when the UI last changed, and
 * the quiet-window arithmetic that decides whether a capture settles the run. Owns that state so the
 * loop above stays the read of one capture at a time.
 */
function createStableCapturePacing(start: number) {
  let lastSignal: StableCaptureSignal | undefined;
  let lastNodeCount = 0;
  let quietSinceMs = start;
  return {
    /** Node count of the most recent capture, reported on every result shape. */
    get lastNodeCount(): number {
      return lastNodeCount;
    },
    /** Folds one capture in: settled, or how long to wait before the next one (<= 0 ends the run). */
    observe(params: {
      signal: StableCaptureSignal;
      nodeCount: number;
      nowMs: number;
      requiredQuietMs: number;
      pollMs: number;
      deadlineMs: number;
      captures: number;
    }): { settled: boolean; delayMs: number } {
      if (!stableCaptureSignalsEqual(lastSignal, params.signal)) {
        // The UI is still moving: the quiet window restarts from this capture.
        lastSignal = params.signal;
        lastNodeCount = params.nodeCount;
        quietSinceMs = params.nowMs;
      } else if (params.captures >= 2 && params.nowMs - quietSinceMs >= params.requiredQuietMs) {
        return { settled: true, delayMs: 0 };
      }
      return {
        settled: false,
        delayMs: stableCaptureDelayMs({
          nowMs: params.nowMs,
          quietSinceMs,
          quietMs: params.requiredQuietMs,
          pollMs: params.pollMs,
          deadlineMs: params.deadlineMs,
        }),
      };
    },
    /** Adopts a capture as the new start of the quiet window without deciding anything. */
    restart(params: { signal: StableCaptureSignal; nodeCount: number; nowMs: number }): void {
      lastSignal = params.signal;
      lastNodeCount = params.nodeCount;
      quietSinceMs = params.nowMs;
    },
    /** The wait before the next capture, given the window currently in force. */
    delayMs(params: {
      nowMs: number;
      requiredQuietMs: number;
      pollMs: number;
      deadlineMs: number;
    }): number {
      return stableCaptureDelayMs({
        nowMs: params.nowMs,
        quietSinceMs,
        quietMs: params.requiredQuietMs,
        pollMs: params.pollMs,
        deadlineMs: params.deadlineMs,
      });
    },
  };
}

/**
 * The broad-transition confirmation, as one decision the settle loop asks about each capture. It
 * compares each capture against the pre-action tree until one proves the replacement, and holds that
 * window for the rest of the run.
 *
 * Two gates stand before the comparison. The pre-action baseline is constant for the run and the
 * only input allowed to rule the confirmation out: a caller that passed none has nothing to confirm
 * against, and a baseline whose producer read no presented surface (`presentedSurface: 'absent'`)
 * has no dismissal to confirm — a tab switch or a push replaces the screen broadly but presents
 * nothing over it (#3470). The fact is stamped before projection, so every flavour of one screen's
 * baseline (interactive, full, depth-limited, scoped, a stored ref frame) answers it alike; no fact,
 * or `'unknown'`, keeps the arming below, so the fact only ever narrows the guard (#3565). The
 * capture gate — the capture proves an iOS XCTest read and carries a complete viewport
 * projection — belongs to each capture, because the first read after a dismissal can still show the
 * dismissed surface, arrive rootless or empty mid-animation, or come from another backend than the
 * next poll will. A capture that fails it leaves the question open; the first capture that passes
 * fixes the comparison baseline, and every later capture is compared against that baseline until one
 * proves the replacement.
 *
 * Arming never consults the requested quiet window: `--settle-quiet` asks for a tighter verdict, not
 * for a different set of transitions to distrust. A confirmed replacement is held for at least the
 * caller's own window, floored at 1.5 s.
 */
function broadTransitionConfirmation(params: {
  baseline: SurfaceScopedNodes | undefined;
  platform: AgentDeviceRuntime['backend']['platform'];
  appBundleId: string | undefined;
}): StableCaptureConfirmation {
  const { platform, appBundleId } = params;
  const baseline = params.baseline?.presentedSurface === 'absent' ? undefined : params.baseline;
  // Open question, not a ruling: `undefined` is the state a capture that cannot support the
  // comparison leaves behind, so arming never depends on which capture happens to land first.
  let transitionBaseline: StableCaptureSignal | undefined;
  // The comparison refuses a node-less side outright, so a mid-animation empty read must not be able
  // to cancel the floor: without the latch it hands the loop its short window back, and the next
  // empty read matches it, settling a dismissal that owed the floor.
  let confirmedQuietMs: number | undefined;
  return {
    // While unconfirmed, do not memoize the verdict on `stableCaptureSignalsEqual`: signal identity
    // omits `role`, parent links, and >1px-free geometry, all of which the chrome classifier reads,
    // and one pass costs tens of microseconds against the 300 ms poll cadence.
    requiredQuietMs(snapshot, currentQuietMs) {
      if (transitionBaseline === undefined && baseline) {
        transitionBaseline = broadTransitionBaseline({
          baseline,
          capture: snapshot,
          platform,
          appBundleId,
        });
      }
      if (!transitionBaseline) return currentQuietMs;
      if (confirmedQuietMs === undefined) {
        const candidate = stableCaptureComparisonSignal(snapshot, snapshot.nodes, appBundleId);
        if (stableCaptureSignalsHaveBroadReplacement(transitionBaseline, candidate)) {
          confirmedQuietMs = Math.max(currentQuietMs, BROAD_TRANSITION_CONFIRMATION_QUIET_MS);
        }
      }
      // Still maxed against the current window: the loop can price a wider one after the latch, on a
      // mid-run fallback from the bridge to the runner.
      return confirmedQuietMs === undefined
        ? currentQuietMs
        : Math.max(currentQuietMs, confirmedQuietMs);
    },
  };
}

type StableCaptureConfirmation = {
  /** The quiet window this capture demands, at least the loop's current one. */
  requiredQuietMs: (
    snapshot: Parameters<typeof stableCaptureSignal>[0],
    currentQuietMs: number,
  ) => number;
};

/**
 * The pre-action tree to confirm against, or `undefined` when the capture in hand cannot support the
 * comparison: the capture must prove an iOS XCTest session (`SnapshotState.backend` is optional at
 * the runtime boundary, so the bound platform stays authoritative when a capture omits that
 * provenance; a declared non-XCTest backend still wins so this confirmation cannot leak onto another
 * capture implementation), and it must be trustworthy evidence about the screen. `undefined` asks the
 * next capture, rather than ruling the transition out for the run.
 */
function broadTransitionBaseline(params: {
  baseline: SurfaceScopedNodes;
  capture: Parameters<typeof stableCaptureSignal>[0];
  platform: AgentDeviceRuntime['backend']['platform'];
  appBundleId: string | undefined;
}): StableCaptureSignal | undefined {
  const { baseline, capture, platform, appBundleId } = params;
  if (!isBoundIosXCTestCapture(capture.backend, platform)) return undefined;
  // A broad *screen* replacement needs a complete post-action viewport projection. The baseline
  // comes from settle's authoritative pre-action capture, but a presented iOS modal can omit its
  // Application root and still be the complete interaction surface. Requiring the root only from
  // the candidate prevents scoped/synthetic post-action fragments from extending settle latency.
  const hasCompleteViewportProjection = capture.nodes.some(isViewportRootNode);
  // A presented pre-action surface is the other trustworthy completeness signal: the first capture
  // after its dismissal can temporarily omit the viewport root, and treating that rootless
  // replacement as an arbitrary scoped projection lets a coherent transitional tree win the plain
  // quiet window. The producer's fact says so outright; without one, a tiny baseline stands in for
  // it, because iOS presents alerts and sheets as a handful of nodes.
  const hasPresentedBaseline =
    baseline.presentedSurface === 'presented' ||
    baseline.nodes.length <= TINY_STABLE_TREE_NODE_COUNT;
  if (!hasCompleteViewportProjection && !hasPresentedBaseline) return undefined;
  return stableCaptureComparisonSignal(capture, baseline.nodes, appBundleId);
}

/**
 * One side of the broad-replacement comparison: a tree minus the chrome the settle diff also
 * collapses (`withoutSettleChrome`). Keyboard surface arriving or leaving — ~40 keys, the candidate
 * bar, the dock buttons on a fill — is not a screen replacement, and counting it as one made every
 * keyboard-raising action pay the 1.5 s confirmation window (#3469). The survivor rule lives in the
 * shared classifier, so this signal and the diff agree on what keyboard chrome is; here it only
 * decides the quiet window, never the visible diff.
 */
function stableCaptureComparisonSignal(
  snapshot: Parameters<typeof stableCaptureSignal>[0],
  nodes: SnapshotNode[],
  appBundleId: string | undefined,
): StableCaptureSignal {
  return stableCaptureSignal({
    ...snapshot,
    nodes: withoutSettleChrome(nodes, appBundleId),
  });
}

function isBoundIosXCTestCapture(
  backend: Parameters<typeof stableCaptureSignal>[0]['backend'],
  platform: AgentDeviceRuntime['backend']['platform'],
): boolean {
  if (backend === 'xctest') return true;
  return backend === undefined && platform === 'ios';
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
// Resolves `stalled` when the capture does not return within remainingMs. A
// stalled backend capture (observed with macOS AX captures) must not push the
// stable wait past the user-supplied timeout into the daemon request timeout.
// The deadline cancels and joins the capture before returning so no late capture
// can overwrite session state or retain a platform helper.
async function captureStableSignalWithinDeadline(
  runtime: AgentDeviceRuntime,
  options: CommandContext & SelectorSnapshotOptions,
  remainingMs: number,
  preferredBackend?: SnapshotPreferredBackend,
): Promise<StableCaptureRead> {
  try {
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
    return result.timedOut ? { kind: 'stalled' } : { kind: 'captured', capture: result.value };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

type StableCaptureRead =
  | { kind: 'captured'; capture: CapturedSnapshot }
  | { kind: 'stalled' }
  | { kind: 'failed'; error: unknown };
