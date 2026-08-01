export const RECORDING_EXPORT_QUALITIES = ['medium', 'high'] as const;
export type RecordingExportQuality = (typeof RECORDING_EXPORT_QUALITIES)[number];

export const DEFAULT_RECORDING_EXPORT_QUALITY: RecordingExportQuality = 'medium';
const RECORDING_LEGACY_QUALITY_MIN = 5;
const RECORDING_LEGACY_QUALITY_MAX = 10;
const RECORDING_LEGACY_MEDIUM_QUALITY_MAX = 7;

export function isRecordingExportQuality(value: unknown): value is RecordingExportQuality {
  return (RECORDING_EXPORT_QUALITIES as readonly unknown[]).includes(value);
}

function toLegacyRecordingQuality(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : parseNumericString(value);
  return numeric !== undefined &&
    Number.isInteger(numeric) &&
    numeric >= RECORDING_LEGACY_QUALITY_MIN &&
    numeric <= RECORDING_LEGACY_QUALITY_MAX
    ? numeric
    : undefined;
}

function parseNumericString(value: unknown): number | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : undefined;
}

export function recordingQualityInputToExportQuality(
  value: RecordingExportQuality | string | number | undefined,
): RecordingExportQuality | undefined {
  if (isRecordingExportQuality(value)) {
    return value;
  }
  const legacyQuality = toLegacyRecordingQuality(value);
  if (legacyQuality !== undefined) {
    return legacyQuality <= RECORDING_LEGACY_MEDIUM_QUALITY_MAX ? 'medium' : 'high';
  }
  return undefined;
}
