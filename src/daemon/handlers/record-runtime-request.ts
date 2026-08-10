import {
  RECORDING_EXPORT_QUALITIES,
  recordingQualityInputToExportQuality,
  type RecordingExportQuality,
  type RecordingScope,
} from '@agent-device/contracts/recording';
import { retiredScreenshotMaxSizeFlagError } from '@agent-device/contracts/capture';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from '../types.ts';
import { hasExplicitSessionFlag } from '../session-routing.ts';

const IOS_DEVICE_RECORD_MIN_FPS = 1;
const IOS_DEVICE_RECORD_MAX_FPS = 120;

export type PreparedRecordingRequest = Readonly<{
  scope: RecordingScope;
  fps?: number;
  exportQuality?: RecordingExportQuality;
  showTouches: boolean;
  hideTouchesRequested: boolean;
}>;

export function prepareRecordingRequest(req: DaemonRequest): PreparedRecordingRequest {
  const removedFlag = retiredScreenshotMaxSizeFlagError('record', req.flags);
  if (removedFlag) throw new AppError('INVALID_ARGS', removedFlag);
  const fps = req.flags?.fps;
  if (
    fps !== undefined &&
    (!Number.isInteger(fps) || fps < IOS_DEVICE_RECORD_MIN_FPS || fps > IOS_DEVICE_RECORD_MAX_FPS)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      `fps must be an integer between ${IOS_DEVICE_RECORD_MIN_FPS} and ${IOS_DEVICE_RECORD_MAX_FPS}`,
    );
  }
  const exportQuality = recordingQualityInputToExportQuality(req.flags?.quality);
  if (req.flags?.quality !== undefined && exportQuality === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      `quality must be one of: ${RECORDING_EXPORT_QUALITIES.join(', ')} (legacy numeric values 5-10 are accepted)`,
    );
  }
  return {
    scope: readRecordingScope(req.flags?.recordingScope),
    ...(fps === undefined ? {} : { fps }),
    ...(exportQuality === undefined ? {} : { exportQuality }),
    showTouches: req.flags?.hideTouches !== true,
    hideTouchesRequested: req.flags?.hideTouches === true,
  };
}

export function readRecordingScope(value: unknown): RecordingScope {
  if (value === undefined) return 'app';
  if (value === 'app' || value === 'device' || value === 'system') return value;
  throw new AppError('INVALID_ARGS', 'record scope must be app, device, or system');
}

export function missingAppSessionResponse(req: DaemonRequest) {
  return {
    ok: false as const,
    error: {
      code: 'INVALID_ARGS',
      message: hasExplicitSessionFlag(req)
        ? 'record start with app scope and an explicit session requires an active app session; run open <app> first, or use --scope device to record the full screen'
        : 'record start defaults to app scope and requires an active app session; run open <app> first, or use --scope device to record the full screen',
    },
  };
}
