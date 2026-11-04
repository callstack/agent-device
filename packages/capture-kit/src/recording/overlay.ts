import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import path from 'node:path';
import { runCmd } from '@agent-device/host-kit/command';
import { Deadline } from '@agent-device/host-kit/retry';
import { AppError, createRequestCanceledError } from '@agent-device/kernel/errors';
import { findProjectRoot } from '@agent-device/host-kit/version';
import { compileSwiftSourceFile, resolveRecordingScriptPath } from './swift-cache.ts';
import {
  createSwiftAttempt,
  recordSwiftPublication,
  releaseSwiftAttempt,
  scheduleSwiftPublicationRemoval,
  scheduleSwiftPublicationRecovery,
  swiftPublicationPath,
  withSwiftAttempt,
  type SwiftAttempt,
} from './swift-attempt.ts';
import { waitForPlayableVideo, type VideoValidator } from './video.ts';
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
 * before the overlay come out of it, as do compiling the overlay helper, exporting, exiting and
 * verifying its output. Past the budget, the stop keeps the raw video and gesture telemetry, with
 * a warning.
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
  telemetryPath: string;
  scriptPath: string;
  scriptArgs: string[];
  commandDescription: string;
  deadline: Deadline;
  signal?: AbortSignal;
  validator: VideoValidator | undefined;
}): Promise<void> {
  const { host, videoPath, telemetryPath, scriptPath, scriptArgs, commandDescription, deadline } =
    params;
  let attempt: SwiftAttempt | undefined;
  let exportOverran = false;
  const deadlineAbort = new AbortController();
  const timer = setTimeout(() => deadlineAbort.abort(), deadline.remainingMs());
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadlineAbort.signal])
    : deadlineAbort.signal;
  scheduleSwiftPublicationRecovery(host.env, videoPath);
  try {
    const executablePath = await compileSwiftSourceFile({
      host,
      sourcePath: scriptPath,
      extraSourcePaths: [getExportSupportScriptPath(host)],
      // `runCmd` reads a timeout of 0 as none.
      timeoutMs: Math.max(1, deadline.remainingMs()),
      signal,
    });
    if (deadline.remainingMs() <= HELPER_EXIT_GRACE_MS) {
      throw new AppError(
        'COMMAND_FAILED',
        `No time was left for the export within the ${OVERLAY_BUDGET_MS}ms budget`,
      );
    }
    attempt = createSwiftAttempt(host.env, 'overlay');
    const publicationPath = swiftPublicationPath(videoPath, path.basename(attempt.directory));
    const work = attempt.work;
    const inputPath = path.join(work, `input${path.extname(videoPath) || '.mp4'}`);
    const outputPath = path.join(work, `output${path.extname(videoPath) || '.mp4'}`);
    const eventsPath = path.join(work, 'events.json');
    await copyOverlayFile(videoPath, inputPath, signal);
    await copyOverlayFile(telemetryPath, eventsPath, signal);
    const helperMs = deadline.remainingMs();
    const exportMs = helperMs - HELPER_EXIT_GRACE_MS;
    if (exportMs <= 0) {
      throw new AppError(
        'COMMAND_FAILED',
        `No time was left for the export within the ${OVERLAY_BUDGET_MS}ms budget`,
      );
    }
    try {
      await withSwiftAttempt(attempt, (env) =>
        runCmd(
          executablePath,
          [
            '--input',
            inputPath,
            '--output',
            outputPath,
            '--events',
            eventsPath,
            ...scriptArgs,
            '--timeout-ms',
            String(Math.round(exportMs)),
          ],
          { timeoutMs: helperMs, cwd: work, env, signal },
        ),
      );
    } catch (error) {
      exportOverran = deadline.remainingMs() <= HELPER_EXIT_GRACE_MS;
      throw error;
    }
    await copyStableOverlay(outputPath, publicationPath, signal, attempt);
    if (
      !(await waitForPlayableVideo(publicationPath, {
        validator: params.validator,
        deadline,
        signal,
      }))
    ) {
      exportOverran = deadline.isExpired();
      throw new AppError('COMMAND_FAILED', 'The composited video was not verified as playable');
    }
    if (signal.aborted)
      throw new AppError('COMMAND_FAILED', 'Overlay finalization deadline expired');
    await fs.promises.rename(publicationPath, videoPath);
  } catch (error) {
    if (params.signal?.aborted) throw createRequestCanceledError();
    if (deadlineAbort.signal.aborted) exportOverran = true;
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
    clearTimeout(timer);
    if (attempt) {
      try {
        releaseSwiftAttempt(attempt);
      } finally {
        scheduleSwiftPublicationRemoval(attempt, videoPath);
      }
    }
  }
}

async function copyOverlayFile(
  source: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  await pipeline(fs.createReadStream(source), fs.createWriteStream(destination, { flags: 'wx' }), {
    signal,
  });
}

async function copyStableOverlay(
  source: string,
  destination: string,
  signal: AbortSignal,
  attempt: SwiftAttempt,
): Promise<void> {
  const before = await fs.promises.stat(source, { bigint: true });
  if (!before.isFile() || before.size === 0n) {
    throw new AppError('COMMAND_FAILED', 'The overlay helper did not produce a video');
  }
  const fd = fs.openSync(destination, 'wx', 0o600);
  let ownedByStream = false;
  try {
    recordSwiftPublication(attempt, fs.fstatSync(fd, { bigint: true }));
    const output = fs.createWriteStream(destination, { fd, autoClose: true });
    ownedByStream = true;
    await pipeline(fs.createReadStream(source), output, { signal });
  } finally {
    if (!ownedByStream) fs.closeSync(fd);
  }
  const after = await fs.promises.stat(source, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new AppError('COMMAND_FAILED', 'The overlay output changed while being copied', {
      reason: 'recording_overlay_output_changed',
    });
  }
}

export async function overlayRecordingTouches(params: {
  host: HostEnvironment;
  validator: VideoValidator | undefined;
  videoPath: string;
  telemetryPath: string;
  exportQuality?: RecordingExportQuality;
  /** The caller's `--fps`; the helper renders at most this many frames a second, capped at 30. */
  fps?: number;
  targetLabel?: string;
  /** From `startRecordingOverlayBudget`, taken when the stop's finalization started. */
  deadline: Deadline;
  signal?: AbortSignal;
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
    telemetryPath,
    scriptPath: getOverlayScriptPath(params.host),
    scriptArgs: [
      '--quality',
      exportQuality,
      ...(params.fps === undefined ? [] : ['--max-fps', String(params.fps)]),
    ],
    commandDescription: `Failed to add touch overlays to the ${targetLabel}`,
    deadline: params.deadline,
    signal: params.signal,
    validator: params.validator,
  });
}
