import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCmd } from '../utils/exec.ts';
import { AppError } from '../kernel/errors.ts';
import { buildSwiftToolEnv, compileSwiftSourceFile } from '../utils/swift-cache.ts';
import { waitForPlayableVideo, waitForStableFile } from '../utils/video.ts';
import {
  DEFAULT_RECORDING_EXPORT_QUALITY,
  type RecordingExportQuality,
} from '../core/recording-export-quality.ts';

function resolveScriptPath(scriptName: string): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const scriptCandidates = [
    fileURLToPath(new URL(`./${scriptName}`, import.meta.url)),
    path.resolve(moduleDir, `../../ios-runner/AgentDeviceRunner/RecordingScripts/${scriptName}`),
    path.resolve(moduleDir, `../../../ios-runner/AgentDeviceRunner/RecordingScripts/${scriptName}`),
    path.resolve(process.cwd(), `ios-runner/AgentDeviceRunner/RecordingScripts/${scriptName}`),
  ];

  for (const candidate of scriptCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new AppError('COMMAND_FAILED', `Missing recording helper script: ${scriptName}`, {
    hint: 'Ensure ios-runner/AgentDeviceRunner/RecordingScripts is present in this checkout or bundled with the package.',
    scriptName,
    searchedPaths: scriptCandidates,
  });
}

let overlayScriptPath: string | undefined;
let trimScriptPath: string | undefined;
let resizeScriptPath: string | undefined;

export function getRecordingOverlaySupportWarning(
  hostPlatform: NodeJS.Platform = process.platform,
): string | undefined {
  if (hostPlatform === 'darwin') {
    return undefined;
  }
  return 'touch overlay burn-in is only available on macOS hosts; returning raw video plus gesture telemetry';
}

function getOverlayScriptPath(): string {
  overlayScriptPath ??= resolveScriptPath('recording-overlay.swift');
  return overlayScriptPath;
}

function getTrimScriptPath(): string {
  trimScriptPath ??= resolveScriptPath('recording-trim.swift');
  return trimScriptPath;
}

function getResizeScriptPath(): string {
  resizeScriptPath ??= resolveScriptPath('recording-resize.swift');
  return resizeScriptPath;
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
    const executablePath = await compileSwiftSourceFile({ sourcePath: scriptPath });
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

export async function trimRecordingStart(params: {
  videoPath: string;
  trimStartMs: number;
}): Promise<void> {
  const { videoPath, trimStartMs } = params;
  if (!(trimStartMs > 0)) return;

  await exportProcessedVideo({
    videoPath,
    scriptPath: getTrimScriptPath(),
    scriptArgs: ['--trim-start-ms', String(trimStartMs)],
    commandDescription: 'Failed to trim the start of the iOS recording',
  });
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

export async function resizeRecording(params: {
  videoPath: string;
  maxSize: number;
  exportQuality?: RecordingExportQuality;
  targetLabel?: string;
}): Promise<void> {
  const {
    videoPath,
    maxSize,
    exportQuality = DEFAULT_RECORDING_EXPORT_QUALITY,
    targetLabel = 'recording',
  } = params;
  await exportProcessedVideo({
    videoPath,
    scriptPath: getResizeScriptPath(),
    scriptArgs: ['--max-size', String(maxSize), '--quality', exportQuality],
    commandDescription: `Failed to resize the ${targetLabel}`,
  });
}
