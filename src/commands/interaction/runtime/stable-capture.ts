import type { SnapshotNode } from '../../../kernel/snapshot.ts';
import type { SnapshotQualityVerdict } from '../../../snapshot/snapshot-quality.ts';
import type { AgentDeviceRuntime, CommandContext } from '../../../runtime-contract.ts';
import { now, sleep } from '../../runtime-common.ts';
import {
  captureSelectorSnapshot,
  type CapturedSnapshot,
  type SelectorSnapshotOptions,
} from './selector-read-shared.ts';

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
  params: { quietMs: number; timeoutMs: number; resetBudgetOnPrivateAxRecovery?: boolean },
): Promise<StableCaptureLoopResult> {
  const { quietMs, timeoutMs } = params;
  const start = now(runtime);
  let deadlineMs = start + timeoutMs;
  let privateAxRecoveryBudgetReset = false;
  // Cadence derives from the quiet window (never slower than the default
  // poll): a caller asking for a 50ms quiet window should not be forced onto a
  // 300ms grid — and tests inject the budget instead of waiting real time.
  const pollMs = Math.min(STABLE_POLL_INTERVAL_MS, Math.max(STABLE_MIN_POLL_MS, quietMs));
  let captures = 0;
  let lastDigest: string | undefined;
  let lastNodeCount = 0;
  let lastCapture: CapturedSnapshot | undefined;
  let quietSinceMs = start;
  while (now(runtime) < deadlineMs) {
    const capture = await captureStableSignalWithinDeadline(
      runtime,
      options,
      deadlineMs - now(runtime),
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
    const digest = digestSnapshotNodes(capture.snapshot.nodes);
    const nowMs = now(runtime);
    if (
      params.resetBudgetOnPrivateAxRecovery === true &&
      !privateAxRecoveryBudgetReset &&
      isPrivateAxRecovery(capture.snapshot.snapshotQuality)
    ) {
      privateAxRecoveryBudgetReset = true;
      deadlineMs = Math.max(deadlineMs, nowMs + timeoutMs);
      quietSinceMs = nowMs;
      lastDigest = digest;
      lastNodeCount = capture.snapshot.nodes.length;
      const recoveryDelayMs = stableCaptureDelayMs({
        nowMs,
        quietSinceMs,
        quietMs,
        pollMs,
        deadlineMs,
      });
      if (recoveryDelayMs <= 0) break;
      await sleep(runtime, recoveryDelayMs);
      continue;
    }
    if (digest !== lastDigest) {
      lastDigest = digest;
      lastNodeCount = capture.snapshot.nodes.length;
      quietSinceMs = nowMs;
    } else if (captures >= 2 && nowMs - quietSinceMs >= quietMs) {
      return {
        settled: true,
        stalled: false,
        waitedMs: nowMs - start,
        captures,
        nodeCount: lastNodeCount,
        lastCapture,
      };
    }
    const delayMs = stableCaptureDelayMs({ nowMs, quietSinceMs, quietMs, pollMs, deadlineMs });
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

function isPrivateAxRecovery(verdict: SnapshotQualityVerdict | undefined): boolean {
  return verdict?.state === 'recovered' && verdict.backend === 'private-ax';
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
// The deadline uses a real timer even when runtime.clock is injected: test
// clocks advance synthetic time synchronously and cannot represent a hung
// backend call.
async function captureStableSignalWithinDeadline(
  runtime: AgentDeviceRuntime,
  options: CommandContext & SelectorSnapshotOptions,
  remainingMs: number,
): Promise<CapturedSnapshot | undefined> {
  const capture = captureSelectorSnapshot(runtime, options, {
    updateSession: false,
    interactiveOnly: true,
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      capture,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remainingMs);
      }),
    ]);
    if (result === undefined) {
      // The abandoned capture settles (or fails) on its own; swallow it so it
      // cannot surface as an unhandled rejection after the wait already threw.
      capture.catch(() => {});
    }
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function digestSnapshotNodes(nodes: SnapshotNode[]): string {
  return nodes.map(digestSnapshotNode).join('|');
}

function digestSnapshotNode(node: SnapshotNode): string {
  const rect = node.rect
    ? `${Math.round(node.rect.x)},${Math.round(node.rect.y)},${Math.round(node.rect.width)},${Math.round(node.rect.height)}`
    : '';
  return `${node.type ?? ''}#${node.label ?? ''}#${node.identifier ?? ''}#${rect}`;
}
