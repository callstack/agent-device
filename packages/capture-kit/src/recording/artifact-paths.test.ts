import { describe, expect, test } from 'vitest';
import {
  collectedRecordingPath,
  nativeRecordingPath,
  recordingContactSheetPath,
} from './artifact-paths.ts';

describe('recording artifact sibling paths', () => {
  test('keeps the recorder file and the collected copy beside the export', () => {
    expect(nativeRecordingPath('/tmp/recording.mp4')).toBe('/tmp/recording.native.mp4');
    expect(collectedRecordingPath('/tmp/recording.mp4')).toBe('/tmp/recording.collected.mp4');
  });

  test('names the contact sheet after the report it is, not the container it came from', () => {
    expect(recordingContactSheetPath('/tmp/recording.mp4')).toBe(
      '/tmp/recording.contact-sheet.png',
    );
    expect(recordingContactSheetPath('/tmp/rec')).toBe('/tmp/rec.contact-sheet.png');
    expect(recordingContactSheetPath('/tmp/rec.TAKE-2.MP4')).toBe(
      '/tmp/rec.TAKE-2.contact-sheet.png',
    );
  });
});
