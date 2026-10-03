import fs from 'node:fs';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
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
}): Promise<void> {
  const { videoPath, scriptPath, scriptArgs, commandDescription } = params;
  await waitForStableFile(videoPath);
  await waitForPlayableVideo(videoPath);

  const outputPath = temporarySiblingVideoPath(videoPath);
  try {
    const executablePath = await compileSwiftSourceFile({
      sourcePath: scriptPath,
      extraSourcePaths: [getExportSupportScriptPath()],
    });
    await runCmd(executablePath, ['--input', videoPath, '--output', outputPath, ...scriptArgs], {
      timeoutMs: 120_000,
      env: buildSwiftToolEnv(),
    });
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
  });
}
