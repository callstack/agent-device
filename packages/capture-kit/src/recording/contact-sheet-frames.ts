import fs from 'node:fs';
import path from 'node:path';
import {
  CONTACT_SHEET_EXTRACTION_REASON,
  CONTACT_SHEET_NO_FRAMES_REASON,
  CONTACT_SHEET_UNSUPPORTED_HOST_REASON,
} from './contact-sheet-report.ts';
import {
  AppError,
  createRequestCanceledError,
  errorMessage,
  isRequestCanceledError,
} from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { findProjectRoot } from '@agent-device/host-kit/version';
import {
  buildSwiftToolEnv,
  compileSwiftSourceFile,
  resolveRecordingScriptPath,
} from './swift-cache.ts';

const FRAMES_SCRIPT = 'recording-frames.swift';
const SHARED_SUPPORT_SCRIPT = 'RecordingExportSupport.swift';
const EXTRACTION_TIMEOUT_MS = 90_000;
const COMPILATION_TIMEOUT_MS = 120_000;

/**
 * Frame decoding is Apple AVFoundation tooling, so a non-macOS host cannot decode a single frame at
 * all. A caller that derives something from a sheet as a convenience catches this and keeps what it
 * has; a caller that was asked for frames reports it.
 */
export function assertContactSheetHostSupport(
  hostPlatform: NodeJS.Platform = process.platform,
): void {
  if (hostPlatform === 'darwin') return;
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'Contact sheets can only be built on macOS hosts, which is where the frame decoder runs',
    {
      reason: CONTACT_SHEET_UNSUPPORTED_HOST_REASON,
      hostPlatform,
      hint: 'Run this command on the macOS host that recorded the clip, or read the video artifact itself.',
    },
  );
}

export type ExtractedRecordingFrame = Readonly<{
  /** The time that was asked for, in milliseconds from the clip start. */
  requestedTimeMs: number;
  /** The time the decoder says the returned frame carries. */
  actualTimeMs: number;
  path: string;
}>;

export type ExtractedRecordingFrames = Readonly<{
  frames: readonly ExtractedRecordingFrame[];
  /** Requested sample times the decoder declined to answer. */
  skippedSampleCount: number;
}>;

/**
 * Decodes the frames at `timesMs` out of a recording into `scratchDir`, which the caller owns.
 *
 * Decoding is Apple AVFoundation tooling compiled through the same cached Swift seam the touch
 * overlay burn-in uses, so a sheet costs one cached compile and one bounded decode pass rather than
 * a new runtime dependency.
 */
export async function extractRecordingFrames(
  input: Readonly<{
    videoPath: string;
    scratchDir: string;
    timesMs: readonly number[];
    /** Widest cell the caller will draw, so no frame is decoded wider than it can be shown. */
    maxWidth: number;
    hostPlatform?: NodeJS.Platform;
    signal?: AbortSignal;
  }>,
): Promise<ExtractedRecordingFrames> {
  // Decoding is the Apple tooling, so the host question has to be answered before this module
  // spawns anything; a caller that only asks for frames gets the same reason as one that asked
  // for a sheet.
  assertContactSheetHostSupport(input.hostPlatform ?? process.platform);
  if (input.timesMs.length === 0) {
    throw new AppError('COMMAND_FAILED', 'Contact sheet sampling requested no frames', {
      reason: CONTACT_SHEET_NO_FRAMES_REASON,
      videoPath: input.videoPath,
    });
  }
  throwIfAborted(input.signal);

  const executablePath = await compileDecoder(input);
  throwIfAborted(input.signal);

  let result;
  try {
    result = await runCmd(
      executablePath,
      [
        '--input',
        input.videoPath,
        '--output-dir',
        input.scratchDir,
        '--times',
        input.timesMs.join(','),
        '--max-width',
        String(input.maxWidth),
      ],
      {
        timeoutMs: EXTRACTION_TIMEOUT_MS,
        env: buildSwiftToolEnv(),
        allowFailure: true,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
  } catch (error) {
    throwExtractionFailure(error, input.videoPath, 'Failed to run the frame decoder');
  }
  if (result.exitCode !== 0) {
    throw new AppError(
      'COMMAND_FAILED',
      `Failed to extract frames from the recording: ${lastNonEmptyLine(result.stderr) || `exit ${result.exitCode}`}`,
      {
        reason: CONTACT_SHEET_EXTRACTION_REASON,
        videoPath: input.videoPath,
        exitCode: result.exitCode,
      },
    );
  }

  const extracted = parseExtractionManifest(
    result.stdout,
    input.videoPath,
    input.scratchDir,
    input.timesMs.length,
  );
  if (extracted.frames.length === 0) {
    throw new AppError(
      'COMMAND_FAILED',
      'The recording returned no decodable frames for a contact sheet',
      {
        reason: CONTACT_SHEET_NO_FRAMES_REASON,
        videoPath: input.videoPath,
        skippedSampleCount: extracted.skippedSampleCount,
      },
    );
  }
  return extracted;
}

type FrameManifest = Readonly<{
  frames: readonly ExtractedRecordingFrame[];
  skippedSampleCount: number;
}>;

function parseExtractionManifest(
  stdout: string,
  videoPath: string,
  scratchDir: string,
  requestedSampleCount: number,
): FrameManifest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (error) {
    throw extractionUnreadable(videoPath, `invalid manifest: ${String(error)}`);
  }

  const frames = readRecord(decoded).frames;
  if (!Array.isArray(frames)) {
    throw extractionUnreadable(videoPath, 'manifest has no frames array');
  }
  const skipped = readRecord(decoded).skipped;

  if (frames.length > requestedSampleCount) {
    throw extractionUnreadable(
      videoPath,
      `returned ${frames.length} frames for ${requestedSampleCount} requested samples`,
    );
  }

  const readable = frames.flatMap((entry) => {
    const frame = readRecord(entry);
    const name = stringField(frame.path);
    const actualTimeMs = numberField(frame.actualTimeMs);
    if (name === undefined || actualTimeMs === undefined || actualTimeMs < 0) {
      // An entry that cannot say which frame it is cannot be shown or counted; the manifest itself
      // is broken, which is a different claim from a sample time the decoder declined.
      throw extractionUnreadable(videoPath, `frame entry is missing a path or presentation time`);
    }
    const framePath = path.resolve(scratchDir, path.basename(name));
    // Bytes that never arrived leave the sample unanswered, which the coverage shortfall below
    // counts; a manifest that promised a frame and delivered nothing cannot be shown as a cell.
    if (!fs.existsSync(framePath)) return [];
    return [
      {
        requestedTimeMs: numberField(frame.requestedTimeMs) ?? actualTimeMs,
        actualTimeMs,
        path: framePath,
      },
    ];
  });

  return {
    // A decoder asked out of order answers out of order; the sheet reads left to right in time.
    frames: readable.sort((left, right) => left.actualTimeMs - right.actualTimeMs),
    // Coverage is what was asked for minus what arrived. Counting the shortfall rather than
    // trusting the manifest's own skipped list keeps a decoder that answers nothing silently
    // impossible: the sheet has to say it saw less than it asked for.
    skippedSampleCount: Math.max(
      Array.isArray(skipped) ? skipped.length : 0,
      requestedSampleCount - readable.length,
    ),
  };
}

function extractionError(message: string, videoPath: string, cause?: unknown): AppError {
  return new AppError(
    'COMMAND_FAILED',
    message,
    { reason: CONTACT_SHEET_EXTRACTION_REASON, videoPath },
    cause,
  );
}

function extractionUnreadable(videoPath: string, detail: string): AppError {
  return extractionError(`Frame extraction returned an unreadable manifest: ${detail}`, videoPath);
}

/**
 * A helper that could not start, was killed at its deadline, or never compiled is an extraction
 * failure too; letting a raw process error escape would strand it outside the typed taxonomy. A
 * canceled request and a failure that already names its reason are both answers the caller asked
 * for, so they travel unchanged.
 */
function throwExtractionFailure(error: unknown, videoPath: string, stage: string): never {
  if (isRequestCanceledError(error)) throw error;
  if (error instanceof AppError && error.code === 'COMMAND_FAILED' && error.details?.reason) {
    throw error;
  }
  throw extractionError(`${stage} for ${videoPath}: ${errorMessage(error)}`, videoPath, error);
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function lastNonEmptyLine(text: string): string {
  return (text.trim().split('\n').pop() ?? '').trim();
}

/**
 * Compiles the decoder helper, or fails as an extraction failure: a cold Swift cache that cannot
 * build the helper is exactly as unable to produce a sheet as a helper that exits nonzero.
 */
async function compileDecoder(input: { videoPath: string; signal?: AbortSignal }): Promise<string> {
  try {
    return await compileSwiftSourceFile({
      sourcePath: resolveRecordingScriptPath(FRAMES_SCRIPT, findProjectRoot()),
      extraSourcePaths: [resolveRecordingScriptPath(SHARED_SUPPORT_SCRIPT, findProjectRoot())],
      cacheName: 'recording-frames',
      timeoutMs: COMPILATION_TIMEOUT_MS,
    });
  } catch (error) {
    throwExtractionFailure(error, input.videoPath, 'Could not build the frame decoder');
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createRequestCanceledError();
}
