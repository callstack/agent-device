import assert from 'node:assert/strict';

import { capturePng, filesDiffer } from './live-assertions.ts';
import type { LiveContext } from './live-harness.ts';

const SURFACE_TRANSITION_TIMEOUT_MS = 10_000;
const SURFACE_TRANSITION_POLL_MS = 250;

/** One screenshot attempt of a surface wait. Writes the observed image to `outputPath`. */
export type SurfaceCapture = (outputPath: string, attempt: number) => Promise<void>;

/**
 * Waits until a fresh screenshot differs from the baseline surface, keeping the final observed
 * image at `outputPath`. System navigation (Home, Recents) is dispatched before the new surface
 * has drawn, so a single capture right after the command can still show the previous surface.
 * Each attempt overwrites `outputPath`, so the file always holds the last observed image, and the
 * wait fails at the deadline if navigation never produced the change.
 */
export async function waitForSurfaceChange(
  context: LiveContext,
  baselinePath: string,
  outputPath: string,
  captureStep: string,
  failure: string,
  capture: SurfaceCapture = (output, attempt) =>
    capturePng(context, `${captureStep} (attempt ${attempt})`, output),
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
    try {
      await capture(outputPath, attempt);
      if (filesDiffer(baselinePath, outputPath)) return;
      lastObservation = `capture ${attempt} still matched ${baselinePath}`;
    } catch (error) {
      lastObservation = `capture ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const pause = Math.min(SURFACE_TRANSITION_POLL_MS, deadline - Date.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  assert.fail(`${failure} within ${SURFACE_TRANSITION_TIMEOUT_MS}ms (${lastObservation})`);
}
