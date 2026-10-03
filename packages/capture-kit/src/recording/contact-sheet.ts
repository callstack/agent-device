import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONTACT_SHEET_CONTAINER_REASON,
  CONTACT_SHEET_EXTRACTION_REASON,
  CONTACT_SHEET_OUTPUT_COLLISION_REASON,
  CONTACT_SHEET_OUTPUT_WRITE_REASON,
  type RecordingContactSheetCell,
  type RecordingContactSheetResult,
} from './contact-sheet-report.ts';
import { publishFileSync } from '@agent-device/host-kit/file';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { decodePngAsync } from '../png-worker-client.ts';
import { readPngSize } from '../png-size.ts';
import { recordingContactSheetPath } from './artifact-paths.ts';
import {
  assertContactSheetHostSupport,
  extractRecordingFrames,
  type ExtractedRecordingFrames,
} from './contact-sheet-frames.ts';
import { CONTACT_SHEET_FRAME_WIDTH, planContactSheetSampleTimes } from './contact-sheet-plan.ts';
import { renderContactSheet } from './contact-sheet-render.ts';
import {
  CONTACT_SHEET_CHANGED_PIXEL_THRESHOLD,
  MAX_CONTACT_SHEET_CELLS,
  selectContactSheetCells,
  type ContactSheetSample,
} from './contact-sheet-selection.ts';
import { readMp4DurationMs } from './mp4-duration.ts';
import { readVideoContainerKind } from './video.ts';

export { recordingContactSheetPath };

/**
 * Publishes what a caller has to name to read the answer: the report the pipeline returns, and the one
 * refusal reason a caller can act on by retrying with another threshold. Every other reason already
 * travels on the error the pipeline threw, so it stays in the module that raises it until some surface
 * asks for it by name.
 */
export { CONTACT_SHEET_THRESHOLD_REASON } from './contact-sheet-report.ts';
export type { RecordingContactSheetResult } from './contact-sheet-report.ts';

/**
 * Builds the one PNG that lets a caller read a recording without playing it.
 *
 * Frames come out of the finished export, never from a parallel capture: the sheet is drawn from
 * the same bytes the caller was handed, so it cannot describe a screen the delivered video does not
 * contain. The grid it samples is bounded by the sheet, not by the clip's length.
 */
export async function buildRecordingContactSheet(
  input: Readonly<{
    videoPath: string;
    outputPath?: string;
    maxPixels: number;
    changedPixelThreshold?: number;
    hostPlatform?: NodeJS.Platform;
    signal?: AbortSignal;
  }>,
): Promise<RecordingContactSheetResult> {
  assertContactSheetHostSupport(input.hostPlatform ?? process.platform);
  const videoPath = path.resolve(input.videoPath);
  const outputPath = path.resolve(input.outputPath ?? recordingContactSheetPath(videoPath));
  assertOutputDoesNotReplaceRecording(videoPath, outputPath);

  const container = await readVideoContainerKind(videoPath);
  if (container !== 'mp4') {
    throw new AppError(
      'INVALID_ARGS',
      container === 'webm'
        ? `Contact sheets need an MP4 recording; ${videoPath} is WebM, whose frames this decoder does not read`
        : `Contact sheets need an MP4 recording; ${videoPath} is not a readable MP4`,
      {
        reason: CONTACT_SHEET_CONTAINER_REASON,
        videoPath,
        container: container ?? 'unknown',
        hint: 'Re-record on a backend that exports MP4, or pass the MP4 artifact the recording produced.',
      },
    );
  }

  const grid = planContactSheetSampleTimes(readMp4DurationMs(videoPath), videoPath);
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-contact-sheet-'));
  try {
    const extracted = await extractRecordingFrames({
      videoPath,
      scratchDir,
      timesMs: grid.timesMs,
      maxWidth: CONTACT_SHEET_FRAME_WIDTH,
      hostPlatform: input.hostPlatform ?? process.platform,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const samples = await decodeFrameSamples(extracted.frames, input.maxPixels);
    throwIfCanceled(input.signal);
    const selection = selectContactSheetCells(
      samples,
      input.changedPixelThreshold ?? CONTACT_SHEET_CHANGED_PIXEL_THRESHOLD,
    );
    const sheet = renderContactSheet({ cells: selection.cells, maxPixels: input.maxPixels });
    writeContactSheetFile(outputPath, sheet.bytes);

    return {
      path: outputPath,
      videoPath,
      durationMs: grid.durationMs,
      width: sheet.width,
      height: sheet.height,
      sampledFrameCount: grid.timesMs.length,
      decodedFrameCount: extracted.frames.length,
      skippedSampleCount: extracted.skippedSampleCount,
      changedPixelThreshold: input.changedPixelThreshold ?? CONTACT_SHEET_CHANGED_PIXEL_THRESHOLD,
      cells: selection.cells.map(toCellSummary),
      ...joinContactSheetWarnings(selection, extracted),
    };
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}

/**
 * Decodes what the decoder handed over, refusing any frame that is bigger than the whole sheet it
 * is meant to fill. The sheet's pixel budget is the caller's ceiling on this command's memory, and
 * a decoder asked for 360px-wide cells that returns something else broke the contract.
 */
async function decodeFrameSamples(
  frames: ExtractedRecordingFrames['frames'],
  maxPixels: number,
): Promise<readonly ContactSheetSample[]> {
  const samples: ContactSheetSample[] = [];
  for (const frame of frames) {
    const size = await readPngSize(frame.path);
    if (size.width > CONTACT_SHEET_FRAME_WIDTH) {
      throw new AppError(
        'COMMAND_FAILED',
        `Frame extraction returned a ${size.width}px-wide frame when the sheet asked for ${CONTACT_SHEET_FRAME_WIDTH}px cells`,
        {
          reason: CONTACT_SHEET_EXTRACTION_REASON,
          framePath: frame.path,
          frameWidth: size.width,
          frameWidthLimit: CONTACT_SHEET_FRAME_WIDTH,
        },
      );
    }
    if (size.width * size.height > maxPixels) {
      throw new AppError(
        'COMMAND_FAILED',
        `Frame extraction returned a ${size.width}x${size.height} frame, above the ${maxPixels}-pixel budget for the whole sheet`,
        {
          reason: CONTACT_SHEET_EXTRACTION_REASON,
          framePath: frame.path,
          framePixels: size.width * size.height,
          maxPixels,
        },
      );
    }
    const image = await decodePngAsync(fs.readFileSync(frame.path), 'recording frame');
    samples.push({ timeMs: frame.actualTimeMs, image });
  }
  return samples;
}

function throwIfCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}

/**
 * A sheet is derived from the recording, so it can never be the thing the recording becomes. The
 * check runs before any decoding so a mistyped --out cannot cost a failed sheet on top of the
 * recording it was pointing at.
 *
 * Resolved path strings cannot answer this on their own: a case-insensitive volume spells the same
 * file two ways, and a hard link or symlink names it from a second path entirely. So an output that
 * already exists is compared by the file it opens, and only an output that does not exist yet —
 * where there is no file to open — falls back to comparing the names.
 */
function assertOutputDoesNotReplaceRecording(videoPath: string, outputPath: string): void {
  const collides = existingFileIdentity(videoPath, outputPath) ?? outputPath === videoPath;
  if (!collides) return;
  throw new AppError(
    'INVALID_ARGS',
    `A contact sheet cannot be written over the recording it describes: ${outputPath}`,
    {
      reason: CONTACT_SHEET_OUTPUT_COLLISION_REASON,
      videoPath,
      outputPath,
      hint: 'Choose a different --out path, or omit it to write beside the recording.',
    },
  );
}

/** Whether both paths open the same file, or `undefined` while one of them opens nothing. */
function existingFileIdentity(left: string, right: string): boolean | undefined {
  const leftStats = statExisting(left);
  const rightStats = statExisting(right);
  if (leftStats === undefined || rightStats === undefined) return undefined;
  return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
}

function statExisting(target: string): fs.Stats | undefined {
  try {
    return fs.statSync(target);
  } catch {
    return undefined;
  }
}

function toCellSummary(cell: {
  timeMs: number;
  changedPixelRatio: number;
}): RecordingContactSheetCell {
  return { timeMs: cell.timeMs, changedPixelRatio: cell.changedPixelRatio };
}

/**
 * Discloses what the grid did not show rather than letting a full-looking sheet imply completeness.
 */
function joinContactSheetWarnings(
  selection: ReturnType<typeof selectContactSheetCells>,
  extracted: ExtractedRecordingFrames,
): { warning?: string } {
  const warnings: string[] = [];
  if (extracted.skippedSampleCount > 0) {
    warnings.push(
      `${extracted.skippedSampleCount} sample times returned no frame, so the sheet covers less of the recording than it asked for`,
    );
  }
  if (selection.thinned) {
    warnings.push(
      `${selection.keptCellCount} changes were found and ${MAX_CONTACT_SHEET_CELLS} cells are printed, so the sheet thins evenly across the recording instead of showing every change`,
    );
  }
  return warnings.length === 0 ? {} : { warning: warnings.join('; ') };
}

/**
 * Publishes the sheet in one move, so a caller can never read a half-written PNG.
 *
 * The staging, the exclusive temp name, and the rename belong to the host's atomic publisher; this
 * only makes sure a directory exists for the sheet it was asked to write and answers a failed write
 * with the reason the command documents.
 */
function writeContactSheetFile(outputPath: string, bytes: Buffer): void {
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    publishFileSync({ destination: outputPath, contents: bytes });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to write the contact sheet to ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
      { reason: CONTACT_SHEET_OUTPUT_WRITE_REASON, outputPath },
    );
  }
}
