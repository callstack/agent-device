import assert from 'node:assert/strict';
import fs from 'node:fs';

import { capturePng, filesDiffer } from './live-assertions.ts';
import type { LiveContext } from './live-harness.ts';

const SURFACE_TRANSITION_TIMEOUT_MS = 10_000;
const SURFACE_TRANSITION_POLL_MS = 250;
const SURFACE_CAPTURE_TIMEOUT_MS = 5_000;

/**
 * One screenshot attempt of a surface wait. Writes the observed image to `outputPath`.
 * `remainingMs` is the wait's remaining deadline when the attempt starts, so a capture can be
 * bounded to it instead of overrunning the wait.
 */
export type SurfaceCapture = (
  outputPath: string,
  attempt: number,
  remainingMs: number,
) => Promise<void>;

/**
 * Waits until a fresh screenshot differs from the baseline surface, keeping the final observed
 * image at `outputPath`. System navigation (Home, Recents) is dispatched before the new surface
 * has drawn, so a single capture right after the command can still show the previous surface.
 * Each attempt removes and overwrites `outputPath`, so the file always holds the last observed
 * image and a failed capture cannot leave a stale one behind. A capture that resolves after the
 * deadline is rejected as a late observation, and the wait fails at the deadline if navigation
 * never produced the change.
 */
export async function waitForSurfaceChange(
  context: LiveContext,
  baselinePath: string,
  outputPath: string,
  captureStep: string,
  failure: string,
  capture?: SurfaceCapture,
): Promise<void> {
  const deadline = Date.now() + SURFACE_TRANSITION_TIMEOUT_MS;
  let lastObservation = 'no capture finished';
  let attempt = 0;
  for (
    let remaining = SURFACE_TRANSITION_TIMEOUT_MS;
    remaining > 0;
    remaining = deadline - Date.now()
  ) {
    attempt += 1;
    fs.rmSync(outputPath, { force: true });
    try {
      await (capture ?? defaultCapture(context, captureStep))(outputPath, attempt, remaining);
      if (Date.now() >= deadline) {
        lastObservation = `capture ${attempt} resolved after the deadline`;
      } else if (filesDiffer(baselinePath, outputPath)) {
        return;
      } else {
        lastObservation = `capture ${attempt} still matched ${baselinePath}`;
      }
    } catch (error) {
      lastObservation = `capture ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const pause = Math.min(SURFACE_TRANSITION_POLL_MS, deadline - Date.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  assert.fail(`${failure} within ${SURFACE_TRANSITION_TIMEOUT_MS}ms (${lastObservation})`);
}

function defaultCapture(context: LiveContext, captureStep: string): SurfaceCapture {
  return (output, attempt, remainingMs) =>
    capturePng(context, `${captureStep} (attempt ${attempt})`, output, {
      // The wait owns the miss policy: a failed attempt is retried under the deadline and only
      // the deadline verdict reports it, so per-attempt failure evidence stays deferred.
      allowFailure: true,
      timeoutMs: Math.min(remainingMs, SURFACE_CAPTURE_TIMEOUT_MS),
    });
}
