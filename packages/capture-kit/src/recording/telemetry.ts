import fs from 'node:fs';
import path from 'node:path';
import type { RecordingGestureEvent } from '@agent-device/contracts/screen-recording-runtime';

type RecordingTelemetryEnvelope = {
  version: 1;
  generatedAt: string;
  events: RecordingGestureEvent[];
};

type RecordingTelemetryState = {
  outPath: string;
  gestureEvents: RecordingGestureEvent[];
  telemetryPath?: string;
};

export function deriveRecordingTelemetryPath(videoPath: string): string {
  const parsed = path.parse(videoPath);
  return path.join(parsed.dir, `${parsed.name}.gesture-telemetry.json`);
}

function normalizeRecordingTelemetryEvents(
  events: RecordingGestureEvent[],
): RecordingGestureEvent[] {
  return [...events].sort((left, right) => left.tMs - right.tMs);
}

function writeRecordingTelemetry(params: {
  videoPath: string;
  events: RecordingGestureEvent[];
}): string {
  const telemetryPath = deriveRecordingTelemetryPath(params.videoPath);
  const payload: RecordingTelemetryEnvelope = {
    version: 1,
    generatedAt: new Date().toISOString(),
    events: normalizeRecordingTelemetryEvents(params.events),
  };
  fs.writeFileSync(telemetryPath, JSON.stringify(payload, null, 2));
  return telemetryPath;
}

export function persistRecordingTelemetry(params: { recording: RecordingTelemetryState }): string {
  const { recording } = params;
  const telemetryPath = writeRecordingTelemetry({
    videoPath: recording.outPath,
    events: recording.gestureEvents,
  });
  recording.telemetryPath = telemetryPath;
  return telemetryPath;
}
