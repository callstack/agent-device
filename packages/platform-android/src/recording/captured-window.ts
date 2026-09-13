import { readMp4DurationMs } from '@agent-device/capture-kit/recording-mp4-duration';

/** Below this, a clip that ends before `record stop` is normal request-and-export latency. */
const IDLE_TAIL_WARNING_MS = 2_000;

/**
 * Measures how much video really reached the pulled chunks. Android's `screenrecord` encodes a
 * frame only when the screen changes, so a clip ends at the frame it encoded last rather than at
 * `record stop`, and the caller needs to know which of the two lengths they are holding.
 *
 * `windowMs` has to be elapsed device time, the span a clip's media timeline is measured from; a
 * host wall-clock window drifts against it and invents a tail that never happened. An unreadable
 * chunk or window costs the caller the measurement, never the recording.
 */
export function measureCapturedWindow(params: {
  chunkPaths: readonly string[];
  windowMs: number | undefined;
}): Readonly<{ capturedDurationMs?: number; idleTailWarning?: string }> {
  const capturedDurationMs = sumCapturedDurationMs(params.chunkPaths);
  if (capturedDurationMs === undefined) return {};
  const windowMs = params.windowMs;
  if (windowMs === undefined) return { capturedDurationMs };
  const idleTailMs = windowMs - capturedDurationMs;
  if (idleTailMs < IDLE_TAIL_WARNING_MS) return { capturedDurationMs };
  return {
    capturedDurationMs,
    idleTailWarning:
      'Android screenrecord encodes a frame only when the screen changes, so this video ends at ' +
      'the last frame it encoded: it covers ' +
      `${formatSeconds(capturedDurationMs)}s of the ${formatSeconds(windowMs)}s recording window.`,
  };
}

function sumCapturedDurationMs(chunkPaths: readonly string[]): number | undefined {
  let total = 0;
  for (const chunkPath of chunkPaths) {
    const durationMs = readMp4DurationMs(chunkPath);
    if (durationMs === undefined) return undefined;
    total += durationMs;
  }
  return total;
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
