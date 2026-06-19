import { describe, expect, test } from 'vitest';
import {
  DEFAULT_RECORDING_EXPORT_QUALITY,
  RECORDING_EXPORT_QUALITIES,
  isRecordingExportQuality,
  recordingQualityInputToExportQuality,
} from '../recording-export-quality.ts';

describe('recording export quality', () => {
  test('defaults to the fast medium export to preserve existing behavior', () => {
    expect(DEFAULT_RECORDING_EXPORT_QUALITY).toBe('medium');
    expect(RECORDING_EXPORT_QUALITIES).toEqual(['medium', 'high']);
  });

  test('guards recognize valid values and reject everything else', () => {
    expect(isRecordingExportQuality('medium')).toBe(true);
    expect(isRecordingExportQuality('high')).toBe(true);
    expect(isRecordingExportQuality('highest')).toBe(false);
    expect(isRecordingExportQuality(undefined)).toBe(false);
    expect(isRecordingExportQuality(10)).toBe(false);
  });

  test('returns export quality for valid quality input', () => {
    expect(recordingQualityInputToExportQuality('medium')).toBe('medium');
    expect(recordingQualityInputToExportQuality('high')).toBe('high');
    expect(recordingQualityInputToExportQuality('highest')).toBeUndefined();
  });
});
