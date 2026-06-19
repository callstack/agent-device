export const RECORDING_EXPORT_QUALITIES = ['medium', 'high'] as const;
export type RecordingExportQuality = (typeof RECORDING_EXPORT_QUALITIES)[number];

export const DEFAULT_RECORDING_EXPORT_QUALITY: RecordingExportQuality = 'medium';

/**
 * Maps an export-quality preset to the matching `AVAssetExportPreset` constant
 * consumed by `recording-resize.swift`. `medium` keeps the fast, simulator-friendly
 * export that is the default; `high` opts into the slower highest-quality export for
 * evidence or artifact-grade recordings.
 */
const RECORDING_EXPORT_QUALITY_PRESETS: Record<RecordingExportQuality, string> = {
  medium: 'AVAssetExportPresetMediumQuality',
  high: 'AVAssetExportPresetHighestQuality',
};

export function recordingExportQualityToPreset(quality: RecordingExportQuality): string {
  return RECORDING_EXPORT_QUALITY_PRESETS[quality];
}

export function isRecordingExportQuality(value: unknown): value is RecordingExportQuality {
  return (RECORDING_EXPORT_QUALITIES as readonly unknown[]).includes(value);
}
