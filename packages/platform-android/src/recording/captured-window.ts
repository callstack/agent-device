import { readMp4DurationMs } from '@agent-device/capture-kit/recording-mp4-duration';

/** Below this, a clip that ends before `record stop` is normal request-and-export latency. */
const IDLE_TAIL_WARNING_MS = 2_000;

/**
 * Measures how much video really reached the pulled chunks and how much of the recording window it
 * covers. Android's `screenrecord` encodes a frame only when the screen changes, so a clip ends at
 * the frame it encoded last rather than at `record stop`, and the caller needs to know which of the
 * two lengths they are holding.
 *
 * The window is host elapsed time between launching the recorder and sending the stop signal, the
 * span this tool itself bracketed; its own export latency belongs to neither. A host that slept
 * mid-recording reports a window shorter than the device saw, which costs the warning rather than
 * inventing one. An unreadable chunk costs the measurement, never the recording.
 */
export function measureCapturedWindow(params: {
  chunkPaths: readonly string[];
  startedAtMs: number;
  stoppedAtMs: number;
}): Readonly<{ capturedDurationMs?: number; idleTailWarning?: string }> {
  const capturedDurationMs = sumCapturedDurationMs(params.chunkPaths);
  if (capturedDurationMs === undefined) return {};
  const windowMs = params.stoppedAtMs - params.startedAtMs;
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
