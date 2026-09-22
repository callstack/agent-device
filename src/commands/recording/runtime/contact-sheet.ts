import path from 'node:path';
import {
  buildRecordingContactSheet,
  CONTACT_SHEET_THRESHOLD_REASON,
  recordingContactSheetPath,
  type RecordingContactSheetResult,
} from '@agent-device/capture-kit/recording-contact-sheet';
import { AppError } from '@agent-device/kernel/errors';
import type {
  ArtifactDescriptor,
  FileInputRef,
  FileOutputRef,
  ReservedOutputFile,
} from '../../../io.ts';
import type { CommandContext } from '../../../runtime-contract.ts';
import type { RuntimeCommand } from '../../runtime-types.ts';
import { reserveCommandOutput, resolveCommandInput } from '../../io-policy.ts';

export type RecordingContactSheetCommandOptions = CommandContext & {
  /** The exported recording to read. A file the caller already holds, not a live capture. */
  video: FileInputRef;
  out?: FileOutputRef;
  changedPixelThreshold?: number;
  /** Print the cells unmarked instead of boxing what moved in each. On by default. */
  diffOverlay?: boolean;
};

export type RecordingContactSheetCommandResult = RecordingContactSheetResult & {
  artifact?: ArtifactDescriptor;
};

/**
 * Draws a contact sheet from an already exported recording.
 *
 * The sheet is a report over a file, so it goes through the local file policy the way a screenshot
 * diff does: it needs no session, no device, and no daemon, and it can be rebuilt from a recording
 * that finished yesterday.
 */
export const contactSheetCommand: RuntimeCommand<
  RecordingContactSheetCommandOptions,
  RecordingContactSheetCommandResult
> = async (runtime, options): Promise<RecordingContactSheetCommandResult> => {
  if (!options.video) {
    throw new AppError('INVALID_ARGS', 'record contact-sheet requires a recording to read');
  }
  assertContactSheetThreshold(options.changedPixelThreshold);

  const video = await resolveCommandInput(runtime, options.video, {
    usage: 'record contact-sheet',
    field: 'video',
  });
  let output: ReservedOutputFile | undefined;

  try {
    // Resolved after the input is materialized so an uploaded recording is released even when no
    // output could be named for it.
    const outputRef = resolveSheetOutputRef(options, options.video, video.path);
    output = await reserveCommandOutput(runtime, outputRef, {
      field: 'path',
      ext: '.png',
      artifactType: 'screen-recording-contact-sheet',
    });
    const sheet = await buildRecordingContactSheet({
      videoPath: video.path,
      outputPath: output.path,
      maxPixels: runtime.policy.maxImagePixels,
      ...(options.changedPixelThreshold === undefined
        ? {}
        : { changedPixelThreshold: options.changedPixelThreshold }),
      ...(options.diffOverlay === undefined ? {} : { diffOverlay: options.diffOverlay }),
      signal: options.signal ?? runtime.signal,
    });
    const artifact = await output.publish();
    return {
      ...sheet,
      path: publishedSheetPath(sheet.path, artifact),
      ...(artifact ? { artifact } : {}),
    };
  } catch (error) {
    await output?.cleanup?.();
    throw error;
  } finally {
    await video.cleanup?.();
  }
};

/**
 * Picks where the sheet lands.
 *
 * A recording addressed by path gets its sibling, which is the convention every other recording
 * report follows. A recording handed over as an uploaded artifact has no caller-visible sibling to
 * derive, so an explicit output is required rather than a path nobody can open.
 */
function resolveSheetOutputRef(
  options: RecordingContactSheetCommandOptions,
  videoRef: FileInputRef,
  resolvedVideoPath: string,
): FileOutputRef {
  if (options.out) return options.out;
  if (videoRef.kind === 'path') {
    return {
      kind: 'path',
      path: path.resolve(recordingContactSheetPath(videoRef.path || resolvedVideoPath)),
    };
  }
  throw new AppError(
    'INVALID_ARGS',
    'record contact-sheet needs an output path when the recording is an uploaded artifact',
    { hint: 'Pass --out <sheet.png> (CLI) or `out` (Node) to name where the sheet is written.' },
  );
}

/**
 * A threshold outside 0..1 is a caller mistake that would either print every sampled frame or
 * refuse every one of them, so it is answered before any decoding is paid for.
 */
function assertContactSheetThreshold(threshold: number | undefined): void {
  if (threshold === undefined) return;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new AppError(
      'INVALID_ARGS',
      `record contact-sheet needs a changedPixelThreshold between 0 and 1, got ${threshold}`,
      {
        reason: CONTACT_SHEET_THRESHOLD_REASON,
        changedPixelThreshold: threshold,
        hint: 'Omit it to use the calibrated default, or pass a share of the frame between 0 and 1.',
      },
    );
  }
}

function publishedSheetPath(sheetPath: string, artifact: ArtifactDescriptor | undefined): string {
  if (!artifact) return sheetPath;
  return artifact.kind === 'localPath' ? artifact.path : (artifact.clientPath ?? sheetPath);
}
