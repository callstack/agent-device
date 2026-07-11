import { isApplePlatform, type DeviceInfo } from '../kernel/device.ts';
import { sleep } from '../utils/timeouts.ts';
export { requireIntInRange } from '../utils/validation.ts';

const DETERMINISTIC_JITTER_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
];

/**
 * Whether a press series should fuse into one or more `sequence` runner requests. Every Apple
 * multi-press variant fuses — plain, double-tap, hold, and jitter series — so the budget chunker
 * bounds per-request wall-clock (the retired `tapSeries` runner command executed all pauses in a
 * single main-thread block, risking the 30s watchdog for large count x interval).
 */
export function shouldUseIosPressSequence(device: DeviceInfo, count: number): boolean {
  return isApplePlatform(device.platform) && count > 1;
}

/**
 * Wall-clock budget (ms) for one fused `sequence` runner request. The runner executes a whole
 * chunk inside a single DispatchQueue.main block guarded by a 30s main-thread watchdog
 * (mainThreadExecutionTimeout); if a chunk's holds + pauses exceed that, the runner reports a
 * timeout while the remaining steps keep mutating the UI. We sub-chunk well under 30s so the
 * estimated holds + pauses + per-step overhead of any single chunk stays safely inside it.
 */
const RUNNER_SEQUENCE_CHUNK_BUDGET_MS = 20_000;

/**
 * Rough fixed per-step cost (ms) the runner spends on each gesture beyond its hold/pause
 * (synthesis, frame resolution, XCTest dispatch). Kept conservative so the budget errs toward
 * smaller chunks rather than risking the watchdog.
 */
const RUNNER_SEQUENCE_STEP_OVERHEAD_MS = 250;

/**
 * Chunks sequence steps by BOTH a hard step-count cap and an estimated wall-clock budget, so a
 * single fused request never risks the runner's 30s main-thread watchdog. Each step's estimated
 * cost is its hold (durationMs) + inter-step pause (pauseMs) + fixed overhead. A step whose own
 * estimated cost already exceeds the budget still gets its own single-step chunk (the daemon-side
 * caps keep one step under 30s: max 10s hold + 10s pause + overhead).
 */
export function chunkRunnerSequenceStepsByBudget<
  T extends { durationMs?: number; pauseMs?: number },
>(steps: T[], maxSteps: number, budgetMs: number = RUNNER_SEQUENCE_CHUNK_BUDGET_MS): T[][] {
  if (steps.length === 0) return [];
  const stepCap = maxSteps > 0 ? maxSteps : steps.length;
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentCostMs = 0;
  for (const step of steps) {
    const stepCostMs =
      (step.durationMs ?? 0) + (step.pauseMs ?? 0) + RUNNER_SEQUENCE_STEP_OVERHEAD_MS;
    const wouldExceedBudget = current.length > 0 && currentCostMs + stepCostMs > budgetMs;
    const wouldExceedCount = current.length >= stepCap;
    if (wouldExceedBudget || wouldExceedCount) {
      chunks.push(current);
      current = [];
      currentCostMs = 0;
    }
    current.push(step);
    currentCostMs += stepCostMs;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function computeDeterministicJitter(index: number, jitterPx: number): [number, number] {
  if (jitterPx <= 0) return [0, 0];
  const [dx, dy] = DETERMINISTIC_JITTER_PATTERN[index % DETERMINISTIC_JITTER_PATTERN.length]!;
  return [dx * jitterPx, dy * jitterPx];
}

export async function runRepeatedSeries(
  count: number,
  pauseMs: number,
  operation: (index: number) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await operation(index);
    if (index < count - 1 && pauseMs > 0) {
      await sleep(pauseMs);
    }
  }
}
