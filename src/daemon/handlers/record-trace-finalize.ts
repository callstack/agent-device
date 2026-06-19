import { persistRecordingTelemetry } from '../recording-telemetry.ts';
import { getRecordingOverlaySupportWarning } from '../../recording/overlay.ts';
import { formatRecordTraceError } from '../record-trace-errors.ts';
import { emitDiagnostic, withDiagnosticTimer } from '../../utils/diagnostics.ts';
import type { RecordTraceDeps } from './record-trace-types.ts';

type FinalizeRecordingOverlayParams = {
  recording: {
    outPath: string;
    gestureEvents: import('../types.ts').RecordingGestureEvent[];
    telemetryPath?: string;
    showTouches: boolean;
    exportQuality?: import('../../core/recording-export-quality.ts').RecordingExportQuality;
    overlayWarning?: string;
  };
  deps: Pick<RecordTraceDeps, 'overlayRecordingTouches'>;
  trimStartMs?: number;
  targetLabel: string;
};

export async function finalizeRecordingOverlay(
  params: FinalizeRecordingOverlayParams,
): Promise<void> {
  const { recording, deps, trimStartMs, targetLabel } = params;

  const telemetryPath = persistRecordingTelemetry({
    recording,
    trimStartMs,
  });

  if (!recording.showTouches) {
    emitDiagnostic({
      level: 'debug',
      phase: 'record_stop_overlay_skipped',
      data: { reason: 'hide_touches' },
    });
    return;
  }

  if (recording.gestureEvents.length === 0) {
    emitDiagnostic({
      level: 'debug',
      phase: 'record_stop_overlay_skipped',
      data: { reason: 'no_gesture_events' },
    });
    return;
  }

  const overlaySupportWarning = getRecordingOverlaySupportWarning();
  if (overlaySupportWarning) {
    recording.overlayWarning ??= overlaySupportWarning;
    return;
  }

  try {
    await withDiagnosticTimer(
      'record_stop_overlay_export',
      () =>
        deps.overlayRecordingTouches({
          videoPath: recording.outPath,
          telemetryPath,
          exportQuality: recording.exportQuality,
          targetLabel,
        }),
      {
        targetLabel,
        gestureEventCount: recording.gestureEvents.length,
      },
    );
  } catch (error) {
    recording.overlayWarning ??= `failed to overlay recording touches: ${formatRecordTraceError(error)}`;
  }
}
