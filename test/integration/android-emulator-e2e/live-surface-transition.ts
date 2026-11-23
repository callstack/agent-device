import assert from 'node:assert/strict';
import fs from 'node:fs';

import { capturePng as defaultPngCapture, filesDiffer } from './live-assertions.ts';
import type { AndroidLiveHarness, LiveContext } from './live-harness.ts';
import type { RunStepOptions } from '../live-device-e2e/runtime.ts';

// One launcher capture took 6.7 s on a hosted emulator, and 8.0 s behind an abandoned one: a
// timed-out CLI does not cancel the capture its daemon already runs. The per-attempt cap holds
// twice that, and the wait holds two capped attempts, so one slow capture cannot use it up.
const SURFACE_CAPTURE_TIMEOUT_MS = 15_000;
const SURFACE_TRANSITION_TIMEOUT_MS = 2 * SURFACE_CAPTURE_TIMEOUT_MS;
const SURFACE_TRANSITION_POLL_MS = 250;

// Every hosted foreground read after Home answered in 193–443 ms and still named the fixture,
// while the launcher was resumed about 1.5 s after the keyevent. The wait shares the surface
// transition's deadline so a foreground verdict can never arrive before a pixel verdict would;
// one read is capped well below it because an `appstate` read is a dumpsys, not a capture.
const FOREGROUND_READ_TIMEOUT_MS = 5_000;

/** A PNG capture step: `screenshot <outputPath> --scale 0.5` with harness step options. */
export type PngCapture = (
  context: LiveContext,
  step: string,
  outputPath: string,
  options: RunStepOptions,
) => Promise<void>;

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

export type SurfaceTransitionOptions = {
  /**
   * Injects one attempt. Tests that inject `capture` bypass the default capture and therefore
   * do not observe its timeout forwarding.
   */
  capture?: SurfaceCapture;
  /**
   * The PNG capture the default attempts run through. Scenarios pass the capture bound to their
   * harness so the default capture's `timeoutMs` reaches the CLI runner of that harness.
   */
  capturePng?: PngCapture;
};

/**
 * Waits until a fresh screenshot differs from the baseline surface, keeping the final observed
 * image at `outputPath`. System navigation (Home, Recents) is dispatched before the new surface
 * has drawn, so a single capture right after the command can still show the previous surface.
 * Each attempt removes and overwrites `outputPath`, so the file always holds the last observed
 * image and a failed capture cannot leave a stale one behind. The default capture is bounded by
 * the remaining deadline (capped per attempt), a capture that resolves after the deadline is
 * rejected as a late observation, and the wait fails at the deadline if navigation never
 * produced the change.
 */
export async function waitForSurfaceChange(
  context: LiveContext,
  baselinePath: string,
  outputPath: string,
  captureStep: string,
  failure: string,
  options: SurfaceTransitionOptions = {},
): Promise<void> {
  const capturePng = options.capturePng ?? defaultPngCapture;
  const capture = options.capture ?? defaultCapture(capturePng, context, captureStep);
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
      await capture(outputPath, attempt, remaining);
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

function defaultCapture(
  capturePng: PngCapture,
  context: LiveContext,
  captureStep: string,
): SurfaceCapture {
  return (output, attempt, remainingMs) =>
    capturePng(context, `${captureStep} (attempt ${attempt})`, output, {
      // The wait owns the miss policy: a failed attempt is retried under the deadline and only
      // the deadline verdict reports it, so per-attempt failure evidence stays deferred.
      allowFailure: true,
      timeoutMs: Math.min(remainingMs, SURFACE_CAPTURE_TIMEOUT_MS),
    });
}

/**
 * Reads one `appstate` foreground answer and returns its foreground package, or `undefined` when
 * the read answered nothing. Only a package the device actually names is reported.
 */
export type ForegroundRead = (attempt: number, remainingMs: number) => Promise<string | undefined>;

/**
 * Waits until the device's reported foreground package leaves `expectedPackage`, and returns the
 * first different answer. `home` injects one keyevent and answers when the injection lands, before
 * WindowManager has resumed the launcher: every hosted failure read the fixture 90–530 ms after
 * the command finished while the launcher was resumed about 1.5 s after it. Each read is bounded
 * below the wait's deadline, a read that resolves after the deadline is rejected as a late
 * observation, and the wait fails at the deadline with the last observation if the foreground
 * never leaves the package.
 */
export async function waitForForegroundLeaves(
  context: LiveContext,
  runStep: AndroidLiveHarness['runStep'],
  expectedPackage: string,
  readStep: string,
  failure: string,
  options: { read?: ForegroundRead } = {},
): Promise<string> {
  const read: ForegroundRead =
    options.read ??
    (async (attempt, remainingMs) => {
      const result = await runStep(context, `${readStep} (attempt ${attempt})`, ['appstate'], {
        allowFailure: true,
        timeoutMs: Math.min(remainingMs, FOREGROUND_READ_TIMEOUT_MS),
      });
      const packageName: unknown = result.json?.data?.package;
      return typeof packageName === 'string' && packageName.length > 0 ? packageName : undefined;
    });
  const deadline = Date.now() + SURFACE_TRANSITION_TIMEOUT_MS;
  let lastObservation = 'no foreground read finished';
  let attempt = 0;
  for (
    let remaining = SURFACE_TRANSITION_TIMEOUT_MS;
    remaining > 0;
    remaining = deadline - Date.now()
  ) {
    attempt += 1;
    try {
      const packageName = await read(attempt, remaining);
      if (Date.now() >= deadline) {
        lastObservation = `foreground read ${attempt} resolved after the deadline`;
      } else if (packageName === undefined) {
        lastObservation = `foreground read ${attempt} reported no package`;
      } else if (packageName !== expectedPackage) {
        return packageName;
      } else {
        lastObservation = `foreground read ${attempt} still reported ${packageName}`;
      }
    } catch (error) {
      lastObservation = `foreground read ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    const pause = Math.min(SURFACE_TRANSITION_POLL_MS, deadline - Date.now());
    if (pause > 0) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  assert.fail(`${failure} within ${SURFACE_TRANSITION_TIMEOUT_MS}ms (${lastObservation})`);
}
