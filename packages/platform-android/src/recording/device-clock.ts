import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';

type RecorderClock = Pick<AndroidScreenRecordingTransport, 'elapsedUptimeMs'>;

/**
 * Reads how long the device has been running: the elapsed recorder time a clip's media timeline is
 * measured from. A failed read costs the caller its duration claim, never the recording.
 */
export async function readElapsedUptimeMs(
  recorderClock: RecorderClock,
  signal?: AbortSignal,
): Promise<number | undefined> {
  try {
    return await recorderClock.elapsedUptimeMs(signal);
  } catch {
    return undefined;
  }
}

/** Recorder time between two uptime reads, or `undefined` when either read failed. */
export function recordingWindowMs(params: {
  stoppedUptimeMs: number | undefined;
  startedUptimeMs: number | undefined;
}): number | undefined {
  const { stoppedUptimeMs, startedUptimeMs } = params;
  if (stoppedUptimeMs === undefined || startedUptimeMs === undefined) return undefined;
  return Math.max(0, stoppedUptimeMs - startedUptimeMs);
}
