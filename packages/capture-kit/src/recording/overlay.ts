import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
import { Deadline } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import { findProjectRoot } from '@agent-device/host-kit/version';
import {
  buildSwiftToolEnv,
  compileSwiftSourceFile,
  resolveRecordingScriptPath,
} from './swift-cache.ts';
import { waitForPlayableVideo, waitForStableFile } from './video.ts';
import {
  DEFAULT_RECORDING_EXPORT_QUALITY,
  type RecordingExportQuality,
} from '@agent-device/contracts/recording';

export function getRecordingOverlaySupportWarning(
  hostPlatform: NodeJS.Platform = process.platform,
): string | undefined {
  if (hostPlatform === 'darwin') {
    return undefined;
  }
  return 'touch overlay burn-in is only available on macOS hosts; returning raw video plus gesture telemetry';
}

/**
 * `record stop` is one daemon request, which the client abandons after `record`'s 90 s envelope:
 * the caller gets "Daemon request timed out" while the daemon finishes the stop. So the overlay must
 * end well inside it. Compiling the helper, its export and its exit all come out of this budget;
 * past it the stop keeps the raw video and its gesture telemetry, with a warning.
 */
export const OVERLAY_BUDGET_MS = 70_000;

/**
 * The helper's time outside its export: starting up, then verifying the composited output or
 * cancelling the export, and exiting.
 */
const HELPER_EXIT_GRACE_MS = 5_000;

let overlayScriptPath: string | undefined;
let exportSupportScriptPath: string | undefined;

function getOverlayScriptPath(): string {
  overlayScriptPath ??= resolveRecordingScriptPath('recording-overlay.swift', findProjectRoot());
  return overlayScriptPath;
}

function getExportSupportScriptPath(): string {
  exportSupportScriptPath ??= resolveRecordingScriptPath(
    'RecordingExportSupport.swift',
    findProjectRoot(),
  );
  return exportSupportScriptPath;
}

async function exportProcessedVideo(params: {
  videoPath: string;
  scriptPath: string;
  scriptArgs: string[];
  commandDescription: string;
  budgetMs: number;
}): Promise<void> {
  const { videoPath, scriptPath, scriptArgs, commandDescription } = params;
  const deadline = Deadline.fromTimeoutMs(params.budgetMs);
  await waitForStableFile(videoPath);
  await waitForPlayableVideo(videoPath);

  const outputPath = temporarySiblingVideoPath(videoPath);
  try {
    const executablePath = await compileSwiftSourceFile({
      sourcePath: scriptPath,
      extraSourcePaths: [getExportSupportScriptPath()],
      // `runCmd` reads a timeout of 0 as none.
      timeoutMs: Math.max(1, deadline.remainingMs()),
    });
    const helperMs = deadline.remainingMs();
    const exportMs = helperMs - HELPER_EXIT_GRACE_MS;
    if (exportMs <= 0) {
      throw new AppError(
        'COMMAND_FAILED',
        `No time was left for the export within the ${params.budgetMs}ms budget`,
      );
    }
    await runCmd(
      executablePath,
      [
        '--input',
        videoPath,
        '--output',
        outputPath,
        ...scriptArgs,
        '--timeout-ms',
        String(Math.round(exportMs)),
      ],
      { timeoutMs: helperMs, env: buildSwiftToolEnv() },
    );
    await waitForPlayableVideo(outputPath);
    fs.renameSync(outputPath, videoPath);
  } catch (error) {
    const cause =
      error instanceof AppError
        ? error
        : new AppError(
            'COMMAND_FAILED',
            String(error),
            undefined,
            error instanceof Error ? error : undefined,
          );
    throw new AppError(
      'COMMAND_FAILED',
      commandDescription,
      {
        ...cause.details,
        videoPath,
        script: scriptPath,
      },
      cause,
    );
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
}

function temporarySiblingVideoPath(videoPath: string): string {
  const parsed = path.parse(videoPath);
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(parsed.dir, `.${parsed.name}.agent-device-${suffix}${parsed.ext || '.mp4'}`);
}

export async function overlayRecordingTouches(params: {
  videoPath: string;
  telemetryPath: string;
  exportQuality?: RecordingExportQuality;
  targetLabel?: string;
}): Promise<void> {
  const {
    videoPath,
    telemetryPath,
    exportQuality = DEFAULT_RECORDING_EXPORT_QUALITY,
    targetLabel = 'recording',
  } = params;
  await exportProcessedVideo({
    videoPath,
    scriptPath: getOverlayScriptPath(),
    scriptArgs: ['--events', telemetryPath, '--quality', exportQuality],
    commandDescription: `Failed to add touch overlays to the ${targetLabel}`,
    budgetMs: OVERLAY_BUDGET_MS,
  });
}
