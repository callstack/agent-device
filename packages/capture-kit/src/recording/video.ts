import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { isCommandTimeoutError, runCmd } from '@agent-device/host-kit/command';
import { type Deadline, sleep } from '@agent-device/host-kit/retry';
import {
  buildSwiftToolEnv,
  compileSwiftSourceText,
  readCompiledSwiftSourceText,
} from './swift-cache.ts';
import type { HostEnvironment } from '@agent-device/kernel/source-value';

import { hasPlayableWebmStructure } from './video-webm.ts';

// Duration zero must pass: a recording of a fully static screen legitimately contains a single
// frame (screenrecord only encodes on screen updates), and AVFoundation reports its duration as 0.
const VIDEO_VALIDATION_SCRIPT = `
import Foundation
import AVFoundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 1

Task {
  defer { semaphore.signal() }
  do {
    let playable = try await asset.load(.isPlayable)
    let duration = try await asset.load(.duration)
    if playable && duration.isValid && !duration.isIndefinite {
      exitCode = 0
    }
  } catch {
    exitCode = 1
  }
}

semaphore.wait()
exit(exitCode)
`.trim();

const VALIDATOR_RUN_TIMEOUT_MS = 10_000;

/** Host-selected validation authority; validation cannot compile. */
export type PreparedVideoValidator =
  | Readonly<{ kind: 'container' }>
  | Readonly<{ kind: 'avfoundation'; executablePath: string; env: NodeJS.ProcessEnv }>;

export type VideoValidator = PreparedVideoValidator | Promise<PreparedVideoValidator>;
const containerVideoValidator = Object.freeze({ kind: 'container' } as const);

/**
 * One runtime host's validator preparation, with the lifetime its compile needs: `prepare` starts
 * or reuses the background compile, `read` answers with what preparation has produced so far, and
 * `close` cancels an unfinished compile and waits for its cleanup. The owner is per runtime host
 * because that is who can close it: the daemon closes its recording host, and a compile that
 * outlived the process which started it would keep `swiftc`, its temporary output and the Swift
 * cache lock behind with nobody left to stop them.
 */
export type VideoValidatorPreparation = Readonly<{
  /** Warms the validator without waiting for it; never starts a second compile for this owner. */
  prepare(): Promise<PreparedVideoValidator>;
  /**
   * Selects container validation or reads prepared authority without compiling. Answers `undefined`
   * when nothing was ever prepared and no executable is published: a stop reports that as its own
   * retriable not-prepared outcome.
   */
  read(): Promise<PreparedVideoValidator> | undefined;
  /** Stops an unfinished compile and awaits its settlement, including temp output and lock cleanup. */
  close(): Promise<void>;
}>;

type VideoValidatorCompile = {
  readonly promise: Promise<PreparedVideoValidator>;
  readonly cancel: AbortController;
  failed: boolean;
};

/** Owns one cache's validator preparation; cross-process compilation stays with the cache lock. */
export function createVideoValidatorPreparation(host: HostEnvironment): VideoValidatorPreparation {
  let compile: VideoValidatorCompile | undefined;
  let closed = false;
  let cleanupFailure: AppError | undefined;
  return Object.freeze({
    prepare: () => {
      if (closed) return Promise.reject(videoValidatorPreparationClosed());
      if (process.platform !== 'darwin') return Promise.resolve(containerVideoValidator);
      if (!compile || compile.failed) {
        const cancel = new AbortController();
        const next: VideoValidatorCompile = {
          cancel,
          failed: false,
          promise: compileVideoValidator(host, cancel.signal),
        };
        compile = next;
        void next.promise.catch((error: unknown) => {
          next.failed = true;
          if (error instanceof AppError && error.details?.reason === 'swift_cache_cleanup_failed') {
            cleanupFailure = error;
          }
        });
      }
      return compile.promise;
    },
    read: () => {
      if (process.platform !== 'darwin') return Promise.resolve(containerVideoValidator);
      const executablePath = readCompiledSwiftSourceText({
        host,
        source: VIDEO_VALIDATION_SCRIPT,
        cacheName: 'video-validator',
      });
      // A published executable answers even after this process's own preparation failed, which is
      // how another process's `prepare ios-runner` recovers a stop in this one.
      if (executablePath) return Promise.resolve(preparedVideoValidator(host, executablePath));
      // A failed preparation stays readable as its own typed failure until an explicit prepare
      // retries it; only a preparation that never started answers no authority at all.
      return compile ? compile.promise : undefined;
    },
    close: async () => {
      closed = true;
      const pending = compile;
      if (!pending) return;
      // The abort is this owner's shutdown, not a request's: it stops `swiftc` through its signal,
      // or stops waiting for another process's compile, and the compile's own cleanup removes its
      // temporary output and gives the cache lock back before this settles.
      pending.cancel.abort();
      await pending.promise.catch(() => undefined);
      if (cleanupFailure) throw cleanupFailure;
    },
  });
}

function preparedVideoValidator(
  host: HostEnvironment,
  executablePath: string,
): PreparedVideoValidator {
  return Object.freeze({ kind: 'avfoundation', executablePath, env: buildSwiftToolEnv(host.env) });
}

/** A preparation whose owner has closed will not compile again; this outcome is terminal. */
function videoValidatorPreparationClosed(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The video validator preparation is closed and will not compile',
    {
      reason: 'video_validator_preparation_closed',
      retriable: false,
      hint: 'This recording host has shut down. Start a recording session on a running host to prepare the validator.',
    },
  );
}

async function compileVideoValidator(
  host: HostEnvironment,
  signal: AbortSignal,
): Promise<PreparedVideoValidator> {
  const { withDiagnosticTimer } = await import('@agent-device/host-kit/diagnostics');
  return await withDiagnosticTimer(
    'prepare_video_validator',
    async () => {
      try {
        const executablePath = await compileSwiftSourceText({
          host,
          source: VIDEO_VALIDATION_SCRIPT,
          cacheName: 'video-validator',
          signal,
        });
        return preparedVideoValidator(host, executablePath);
      } catch (error) {
        if (isUnavailableVideoValidatorError(error)) {
          throw unavailableVideoValidator(error);
        }
        throw error;
      }
    },
    undefined,
    'preparation_start',
  );
}

function unavailableVideoValidator(cause?: Error): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The video validator is unavailable; MP4 playability cannot be verified',
    {
      ...(cause instanceof AppError ? cause.details : {}),
      reason: 'video_validator_unavailable',
      retriable: false,
      hint: 'Install the Xcode command line tools with AVFoundation on the recording host, then run agent-device prepare ios-runner --platform ios there using the same Swift cache. Once preparation is ready, retry record stop in the original recording session.',
    },
    cause,
  );
}

function isUnavailableVideoValidatorError(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    (error.code === 'TOOL_MISSING' ||
      isSwiftVideoValidatorUnavailable(
        String(error.details?.stderr ?? ''),
        String(error.details?.stdout ?? ''),
      ))
  );
}

export async function waitForStableFile(
  filePath: string,
  options: { pollMs?: number; attempts?: number } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 150;
  const attempts = options.attempts ?? 12;
  let previousSize: number | undefined;
  let stableCount = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let currentSize = 0;
    try {
      currentSize = fs.statSync(filePath).size;
    } catch {
      currentSize = 0;
    }

    if (currentSize > 0 && currentSize === previousSize) {
      stableCount += 1;
      if (stableCount >= 2) {
        return;
      }
    } else {
      stableCount = 0;
    }

    previousSize = currentSize;
    await sleep(pollMs);
  }
}

/** Uses prepared validation authority; executable runs stay within the finalization deadline. */
export async function isPlayableVideo(
  filePath: string,
  validator: VideoValidator | undefined,
  deadline?: Deadline,
): Promise<boolean> {
  const container = await readVideoContainerKind(filePath);
  if (!container) return false;
  // AVFoundation is the MP4 semantic validator. It does not reliably load WebM on supported
  // macOS hosts, so WebM completion is established by its EBML document type + Segment marker.
  if (container === 'webm') return true;
  const notPrepared = () =>
    new AppError(
      'COMMAND_FAILED',
      'The video validator is not ready within the finalization budget',
      {
        reason: 'video_validator_not_prepared',
        retriable: true,
        hint: 'Preparation continues in the background. Retry record stop in this session once the validator is ready.',
      },
    );
  if (!validator) {
    throw new AppError('COMMAND_FAILED', 'The video validator has not been prepared', {
      reason: 'video_validator_not_prepared',
      retriable: true,
      hint: 'Run agent-device prepare ios-runner --platform ios on the recording host using the same Swift cache. Once preparation is ready, retry record stop in the original recording session.',
    });
  }
  let timer: NodeJS.Timeout | undefined;
  let prepared: PreparedVideoValidator;
  try {
    prepared = await Promise.race([
      validator,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(notPrepared()),
          deadline?.remainingMs() ?? VALIDATOR_RUN_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (prepared.kind === 'container') return true;
  const runTimeoutMs = Math.min(
    VALIDATOR_RUN_TIMEOUT_MS,
    deadline?.remainingMs() ?? VALIDATOR_RUN_TIMEOUT_MS,
  );
  if (runTimeoutMs <= 0) return false;
  const result = await runCmd(prepared.executablePath, [filePath], {
    allowFailure: true,
    timeoutMs: runTimeoutMs,
    env: prepared.env,
  }).catch((error: unknown) => {
    if (isCommandTimeoutError(error)) return undefined;
    if (isUnavailableVideoValidatorError(error)) throw unavailableVideoValidator(error);
    throw error;
  });
  if (!result) return false;
  if (isSwiftVideoValidatorUnavailable(result.stderr, result.stdout)) {
    throw unavailableVideoValidator(
      new AppError('COMMAND_FAILED', 'The prepared video validator could not run', result),
    );
  }
  return result.exitCode === 0;
}

/**
 * Polls until the file plays, for `attempts` polls or until `deadline` passes, whichever is first,
 * and resolves whether it played.
 */
export async function waitForPlayableVideo(
  filePath: string,
  options: {
    validator: VideoValidator | undefined;
    pollMs?: number;
    attempts?: number;
    deadline?: Deadline;
  },
): Promise<boolean> {
  const pollMs = options.pollMs ?? 150;
  const attempts = options.attempts ?? 12;

  for (let attempt = 1; ; attempt += 1) {
    if (await isPlayableVideo(filePath, options.validator, options.deadline)) {
      return true;
    }
    if (attempt >= attempts || options.deadline?.isExpired()) {
      return false;
    }
    await sleep(pollMs);
  }
}

function isSwiftVideoValidatorUnavailable(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`;
  return /\b(no such module ['"]AVFoundation['"]|unable to find utility ["']swiftc?["'])/i.test(
    combined,
  );
}

/**
 * The container sniff alone: `ftyp` and `moov` for MP4, the EBML segment for WebM. It reads the file and
 * spawns nothing, which is what lets a stop check a copy before it trusts it (ADR 0024 2.3).
 */
export async function hasVideoContainer(filePath: string): Promise<boolean> {
  return (await readVideoContainerKind(filePath)) !== undefined;
}

/**
 * Which video container a file actually is, sniffed from its bytes rather than its name. Callers
 * that can only decode one container ask this before they spawn a decoder, because a `.mp4` that
 * is not an MP4 and a WebM that is named well both answer differently.
 */
export async function readVideoContainerKind(
  filePath: string,
): Promise<'mp4' | 'webm' | undefined> {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  if (filePath.toLowerCase().endsWith('.webm')) {
    return hasPlayableWebmStructure(filePath) ? 'webm' : undefined;
  }
  return (await isMp4Container(filePath)) ? 'mp4' : undefined;
}

// Loaded on the first validated file rather than on import: this scan is what a recording
// completion asks for, and nothing that merely imports this module should evaluate it.
async function isMp4Container(filePath: string): Promise<boolean> {
  const { findMp4Atom } = await import('./mp4-atoms.ts');
  return (
    findMp4Atom(filePath, ['ftyp']) !== undefined && findMp4Atom(filePath, ['moov']) !== undefined
  );
}
