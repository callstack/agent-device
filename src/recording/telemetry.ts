import fs from 'node:fs';
import path from 'node:path';
import type { RecordingGestureEvent } from '@agent-device/contracts/platform';

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

function trimRecordingTelemetryEvents(
  events: RecordingGestureEvent[],
  trimStartMs: number,
): RecordingGestureEvent[] {
  if (!(trimStartMs > 0)) {
    return normalizeRecordingTelemetryEvents(events);
  }

  return normalizeRecordingTelemetryEvents(
    events.flatMap((event) => {
      const adjustedStartMs = event.tMs - trimStartMs;
      const durationMs = 'durationMs' in event ? event.durationMs : undefined;
      const adjustedEndMs =
        typeof durationMs === 'number' ? adjustedStartMs + durationMs : adjustedStartMs;

      if (adjustedEndMs <= 0) {
        return [];
      }

      return [
        {
          ...event,
          tMs: Math.max(0, adjustedStartMs),
        },
      ];
    }),
  );
}

function normalizeRecordingTelemetryEvents(
  events: RecordingGestureEvent[],
): RecordingGestureEvent[] {
  return [...events].sort((left, right) => left.tMs - right.tMs);
}

function writeRecordingTelemetry(params: {
  videoPath: string;
  events: RecordingGestureEvent[];
  trimStartMs?: number;
}): string {
  const telemetryPath = deriveRecordingTelemetryPath(params.videoPath);
  const payload: RecordingTelemetryEnvelope = {
    version: 1,
    generatedAt: new Date().toISOString(),
    events: trimRecordingTelemetryEvents(params.events, params.trimStartMs ?? 0),
  };
  fs.writeFileSync(telemetryPath, JSON.stringify(payload, null, 2));
  return telemetryPath;
}

export function persistRecordingTelemetry(params: {
  recording: RecordingTelemetryState;
  trimStartMs?: number;
}): string {
  const { recording, trimStartMs } = params;
  const telemetryPath = writeRecordingTelemetry({
    videoPath: recording.outPath,
    events: recording.gestureEvents,
    trimStartMs,
  });
  recording.telemetryPath = telemetryPath;
  return telemetryPath;
}
