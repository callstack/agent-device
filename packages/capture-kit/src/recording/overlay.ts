import fs from 'node:fs';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
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
import { waitForPlayableVideo } from './video.ts';
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
 * end well inside it. The budget starts with the stop's finalization, so the playability checks
 * before the overlay (on a cold host they compile their validator first) come out of it, as do
 * compiling the helper, its export, its exit and verifying its output; past it the stop keeps the raw video and its
 * gesture telemetry, with a warning.
 */
export const OVERLAY_BUDGET_MS = 70_000;

/** Starts the overlay budget. Call it when the stop's finalization starts, not when the overlay does. */
export function startRecordingOverlayBudget(): Deadline {
  return Deadline.fromTimeoutMs(OVERLAY_BUDGET_MS);
}

/**
 * The helper's time outside its export: starting up, then verifying the composited output or
 * cancelling the export, and exiting.
 */
const HELPER_EXIT_GRACE_MS = 5_000;

// The working-directory fallback in the search makes a resolved script path specific to the host's
// directory, so each directory keeps its own.
const overlayScriptPaths = new Map<string, string>();
const exportSupportScriptPaths = new Map<string, string>();

function resolveCachedScriptPath(
  cache: Map<string, string>,
  scriptName: string,
  host: HostEnvironment,
): string {
  let resolved = cache.get(host.cwd);
  if (resolved === undefined) {
    resolved = resolveRecordingScriptPath(scriptName, findProjectRoot(), host.cwd);
    cache.set(host.cwd, resolved);
  }
  return resolved;
}

function getOverlayScriptPath(host: HostEnvironment): string {
  return resolveCachedScriptPath(overlayScriptPaths, 'recording-overlay.swift', host);
}

function getExportSupportScriptPath(host: HostEnvironment): string {
  return resolveCachedScriptPath(exportSupportScriptPaths, 'RecordingExportSupport.swift', host);
}

async function exportProcessedVideo(params: {
  host: HostEnvironment;
  videoPath: string;
  scriptPath: string;
  scriptArgs: string[];
  commandDescription: string;
  deadline: Deadline;
}): Promise<void> {
  const { host, videoPath, scriptPath, scriptArgs, commandDescription, deadline } = params;
  const outputPath = temporarySiblingVideoPath(videoPath);
  let exportOverran = false;
  try {
    const executablePath = await compileSwiftSourceFile({
      host,
      sourcePath: scriptPath,
      extraSourcePaths: [getExportSupportScriptPath(host)],
      // `runCmd` reads a timeout of 0 as none.
      timeoutMs: Math.max(1, deadline.remainingMs()),
    });
    const helperMs = deadline.remainingMs();
    const exportMs = helperMs - HELPER_EXIT_GRACE_MS;
    if (exportMs <= 0) {
      throw new AppError(
        'COMMAND_FAILED',
        `No time was left for the export within the ${OVERLAY_BUDGET_MS}ms budget`,
      );
    }
    try {
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
        { timeoutMs: helperMs, env: buildSwiftToolEnv(host.env) },
      );
    } catch (error) {
      exportOverran = deadline.remainingMs() <= HELPER_EXIT_GRACE_MS;
      throw error;
    }
    await waitForPlayableVideo(outputPath, { host, deadline });
    if (deadline.isExpired()) {
      exportOverran = true;
      throw new AppError(
        'COMMAND_FAILED',
        'The composited video was not verified within the budget',
      );
    }
    fs.renameSync(outputPath, videoPath);
  } catch (error) {
    const description = exportOverran
      ? `${commandDescription}: the export did not finish within its ${OVERLAY_BUDGET_MS}ms budget; a lower --fps renders faster`
      : commandDescription;
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
      description,
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
  host: HostEnvironment;
  videoPath: string;
  telemetryPath: string;
  exportQuality?: RecordingExportQuality;
  /** The caller's `--fps`; the helper renders at most this many frames a second, capped at 30. */
  fps?: number;
  targetLabel?: string;
  /** From `startRecordingOverlayBudget`, taken when the stop's finalization started. */
  deadline: Deadline;
}): Promise<void> {
  const {
    videoPath,
    telemetryPath,
    exportQuality = DEFAULT_RECORDING_EXPORT_QUALITY,
    targetLabel = 'recording',
  } = params;
  await exportProcessedVideo({
    host: params.host,
    videoPath,
    scriptPath: getOverlayScriptPath(params.host),
    scriptArgs: [
      '--events',
      telemetryPath,
      '--quality',
      exportQuality,
      ...(params.fps === undefined ? [] : ['--max-fps', String(params.fps)]),
    ],
    commandDescription: `Failed to add touch overlays to the ${targetLabel}`,
    deadline: params.deadline,
  });
}
