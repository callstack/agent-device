import { createHash } from 'node:crypto';

export type AndroidRecordingGeneration = Readonly<{
  deviceId: string;
  sessionId: string;
  fence: Readonly<{ token: string; generation: number }>;
  claimToken?: string;
}>;

export function recordingGenerationKey(input: AndroidRecordingGeneration): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.deviceId,
        input.sessionId,
        input.claimToken ?? null,
        input.fence.token,
        input.fence.generation,
      ]),
    )
    .digest('hex');
}

export function recordingMarkerPath(
  directory: string,
  generation: AndroidRecordingGeneration,
): string {
  return `${directory}/agent-device-recording-v2-${recordingGenerationKey(generation)}.json`;
}

export function recordingArtifactPath(
  directory: string,
  generation: AndroidRecordingGeneration,
  now: number,
): string {
  return `${directory}/agent-device-recording-v2-${recordingGenerationKey(generation)}-${now}.mp4`;
}

export function legacyRecordingMarkerPaths(): readonly string[] {
  return [
    '/sdcard/agent-device-recording-active.json',
    '/data/local/tmp/agent-device-recording-active.json',
  ];
}
