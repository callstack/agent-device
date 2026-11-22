import type { ReasonTable } from '@agent-device/kernel/errors';

/**
 * What a contact sheet reports: the shape of the finished grid, and the typed reasons it refuses with
 * when there is no grid to draw. Both stay here rather than in cross-layer contracts because nothing
 * but this package's pipeline produces them and the surface that reads them already imports this
 * package; a caller branches on a reason instead of reading an error message.
 */
export const CONTACT_SHEET_REASONS = {
  // The host cannot decode frames at all: frame decoding is Apple AVFoundation tooling.
  unsupportedHost: { reason: 'contact_sheet_unsupported_host' },
  // The MP4 timeline could not be read, so no bounded sample grid can be planned.
  durationUnknown: { reason: 'contact_sheet_duration_unknown' },
  // The contact sheet could not obtain usable extracted frames: the extractor failed to start, run, or return frames the sheet can use.
  frameExtractionFailed: { reason: 'contact_sheet_frame_extraction_failed' },
  // Extraction returned nothing usable, so there is no sheet to draw.
  noFrames: { reason: 'contact_sheet_no_frames' },
  // The sheet would exceed the caller's image pixel budget even at the smallest cell.
  pixelBudgetExceeded: { reason: 'contact_sheet_pixel_budget_exceeded' },
  // The file is present but is not a container this feature decodes, such as a WebM recording.
  containerUnsupported: { reason: 'contact_sheet_container_unsupported' },
  // The sheet could not be written where it was asked to land.
  outputWriteFailed: { reason: 'contact_sheet_output_write_failed' },
  // The output resolves to the recording itself, which a sheet must never replace.
  outputCollidesWithInput: { reason: 'contact_sheet_output_collides_with_input' },
  // The change threshold is not a finite share between 0 and 1.
  thresholdInvalid: { reason: 'contact_sheet_threshold_invalid' },
} as const satisfies ReasonTable<'record'>;

export type RecordingContactSheetCell = {
  /** Presentation time of the decoded frame this cell shows, in milliseconds from the clip start. */
  readonly timeMs: number;
  /** Share of pixels that moved since the previously kept cell, from 0 to 1. */
  readonly changedPixelRatio: number;
};

export type RecordingContactSheetResult = {
  readonly path: string;
  readonly videoPath: string;
  /** Video timeline the grid was planned over, in milliseconds. */
  readonly durationMs: number;
  readonly width: number;
  readonly height: number;
  /**
   * Sample times the grid asked for. Sampling is a grid, not a scan: a transient that falls wholly
   * between two sample times is absent from the sheet.
   */
  readonly sampledFrameCount: number;
  /** Frames the decoder actually returned. */
  readonly decodedFrameCount: number;
  /** Requested sample times the decoder declined to answer. */
  readonly skippedSampleCount: number;
  /** Changed-pixel share a frame had to exceed to earn its own cell. */
  readonly changedPixelThreshold: number;
  readonly cells: readonly RecordingContactSheetCell[];
  readonly warning?: string;
};
