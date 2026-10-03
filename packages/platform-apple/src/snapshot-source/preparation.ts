import { BUILD_TIMEOUT_MS, ensureSnapshotBridgeBinary } from './cache.ts';
import { COLD_TOOLCHAIN_PROBE_TIMEOUT_MS } from '../runner/apple-runner-platform.ts';
import { createDetachedAttempts } from '../detached-attempt.ts';
import {
  createSnapshotSourceDeadline,
  waitForSnapshotSourceDelay,
  type SnapshotSourceDeadline,
} from './deadline.ts';
import { asSnapshotSourceError, snapshotSourceError } from './errors.ts';
import type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceHost,
  SnapshotSourceLimits,
} from './types.ts';

/**
 * Ceiling on one detached preparation, sized from the two costs it can honestly pay: a cold Apple
 * toolchain probe stall on a fresh host (`COLD_TOOLCHAIN_PROBE_TIMEOUT_MS`, #2422) and one clang
 * build (`BUILD_TIMEOUT_MS`). No capture waits this long; it serves from the XCTest runner instead.
 */
const SNAPSHOT_BRIDGE_PREPARATION_DEADLINE_MS = COLD_TOOLCHAIN_PROBE_TIMEOUT_MS + BUILD_TIMEOUT_MS;

/**
 * How long one capture may wait for a preparation before the XCTest runner serves it. Measured on a
 * warm cache, the first preparation in a fresh daemon process costs 1.5 s here — mostly the first
 * in-process Apple toolchain probe — and 0.1 s after that, so this budget keeps a cached bridge on
 * the bridge path. What it cannot cover is a cold host: the probe stall of #2422 or a clang build is
 * host-setup cost, and that belongs to the daemon rather than to one capture (#2491).
 *
 * Granted to the first capture that finds an attempt running, not to each of them: a `wait` poll
 * cycles about every 200 ms, and a budget paid per poll would cost a cold build ten times its own
 * cost in captured polls that all end up on the runner anyway.
 */
const SNAPSHOT_BRIDGE_PREPARATION_WAIT_BUDGET_MS = 2_000;

/**
 * A failed attempt is reported as-is for this long instead of starting another build per capture.
 * The retry is what recovers a one-off probe timeout; the window is what stops a tight wait-poll
 * loop from launching a compile every 200 ms. Measured from the failure, because a cold host can
 * spend the whole window building before it fails at all.
 */
export const SNAPSHOT_BRIDGE_PREPARATION_RETRY_AFTER_MS = 60_000;

export type SnapshotBridgePreparation = Readonly<{
  /**
   * The bridge binary for `runtime`, starting a detached preparation when none is running. An
   * attempt still running when `deadline` has spent its wait budget is reported as `preparing` and
   * keeps running: the caller serves that capture another way instead of paying for it.
   */
  readyBinary(
    runtime: string,
    deadline: SnapshotSourceDeadline,
    code: string,
  ): Promise<SnapshotSourceBridgeBinary>;
  /** Stops a build that is still running. Called when the snapshot source closes. */
  close(): void;
}>;

export function createSnapshotBridgePreparation(
  deps: Readonly<{
    host: SnapshotSourceHost;
    limits: SnapshotSourceLimits;
    producer: string;
    sourceRoot?: string;
    cacheRoot?: string;
    now?: () => number;
  }>,
): SnapshotBridgePreparation {
  const now = deps.now ?? Date.now;
  // The binary a finished preparation produced. Content-addressed and verified at rest, so it is
  // good for the life of this source; re-deriving it per capture would re-hash the bridge source
  // every time. This is the cache the attempt table deliberately does not keep.
  const binaries = new Map<string, SnapshotSourceBridgeBinary>();
  const attempts = createDetachedAttempts<SnapshotSourceBridgeBinary>({
    waitMs: SNAPSHOT_BRIDGE_PREPARATION_WAIT_BUDGET_MS,
    waitGrant: 'first-caller',
    retryAfterMs: SNAPSHOT_BRIDGE_PREPARATION_RETRY_AFTER_MS,
    now,
  });

  const build = async (
    runtime: string,
    signal: AbortSignal,
  ): Promise<SnapshotSourceBridgeBinary> => {
    // The preparation carries the signal `close()` aborts: once a capture has answered there is no
    // request deadline left to stop this build, and a bridge write landing after the source closed
    // belongs to nobody (#2491).
    const deadline = createSnapshotSourceDeadline(
      SNAPSHOT_BRIDGE_PREPARATION_DEADLINE_MS,
      signal,
      now,
    );
    try {
      const binary = await deps.host.withDiagnosticTimer(
        'ios.snapshot-source.prepare',
        async () =>
          await ensureSnapshotBridgeBinary({
            host: deps.host,
            runtime,
            limits: deps.limits,
            deadline,
            sourceRoot: deps.sourceRoot,
            cacheRoot: deps.cacheRoot,
          }),
        { producer: deps.producer },
      );
      binaries.set(runtime, binary);
      return binary;
    } catch (error) {
      throw asSnapshotSourceError(error);
    }
  };

  return {
    readyBinary: async (runtime, deadline, code) => {
      const binary = binaries.get(runtime);
      if (binary) return binary;
      return await attempts.value(runtime, {
        start: (signal) => build(runtime, signal),
        // Waiting inside the request's own deadline keeps a genuine client abort typed
        // `cancelled`: only a preparation that is simply still running is reported as `preparing`.
        wait: (waitMs, stop) => waitForSnapshotSourceDelay(deadline, waitMs, code, stop),
        pending: () => snapshotSourceError('preparing', 'bridge-preparation-pending'),
      });
    },
    close: () => {
      binaries.clear();
      attempts.close();
    },
  };
}
