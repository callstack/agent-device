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

/** Executable authority prepared before the recorder starts; validation cannot compile. */
export type PreparedVideoValidator = Readonly<{
  executablePath: string;
  env: NodeJS.ProcessEnv;
}>;

/** Reads prepared executable authority from the host cache without compiling. */
export function readPreparedVideoValidator(
  host: HostEnvironment,
): PreparedVideoValidator | undefined {
  const executablePath = readCompiledSwiftSourceText({
    host,
    source: VIDEO_VALIDATION_SCRIPT,
    cacheName: 'video-validator',
  });
  return executablePath ? preparedVideoValidator(host, executablePath) : undefined;
}

function preparedVideoValidator(
  host: HostEnvironment,
  executablePath: string,
): PreparedVideoValidator {
  return Object.freeze({ executablePath, env: buildSwiftToolEnv(host.env) });
}

export async function prepareVideoValidator(
  host: HostEnvironment,
  signal?: AbortSignal,
  timeoutMs?: number,
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
          timeoutMs,
        });
        return preparedVideoValidator(host, executablePath);
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === 'TOOL_MISSING' ||
            isSwiftVideoValidatorUnavailable(
              String(error.details?.stderr ?? ''),
              String(error.details?.stdout ?? ''),
            ))
        ) {
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
      reason: 'video_validator_unavailable',
      retriable: false,
      hint: 'Install the Xcode command line tools with AVFoundation on the recording host, then start a new recording.',
    },
    cause,
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

/** Validates with a prepared executable, bounded by the caller's finalization deadline. */
export async function isPlayableVideo(
  filePath: string,
  validator: PreparedVideoValidator | undefined,
  deadline?: Deadline,
): Promise<boolean> {
  const container = await readVideoContainerKind(filePath);
  if (!container) return false;
  // AVFoundation is the MP4 semantic validator. It does not reliably load WebM on supported
  // macOS hosts, so WebM completion is established by its EBML document type + Segment marker.
  if (container === 'webm') return true;
  if (!validator) {
    throw new AppError(
      'COMMAND_FAILED',
      'The video validator was not prepared before finalization',
      {
        reason: 'video_validator_not_prepared',
        retriable: true,
        hint: 'Run prepare ios-runner on this host to prepare recording helpers, then retry record stop in this session.',
      },
    );
  }
  const runTimeoutMs = Math.min(
    VALIDATOR_RUN_TIMEOUT_MS,
    deadline?.remainingMs() ?? VALIDATOR_RUN_TIMEOUT_MS,
  );
  if (runTimeoutMs <= 0) return false;
  const result = await runCmd(validator.executablePath, [filePath], {
    allowFailure: true,
    timeoutMs: runTimeoutMs,
    env: validator.env,
  }).catch((error: unknown) => {
    if (isCommandTimeoutError(error)) return undefined;
    throw error;
  });
  if (!result) return false;
  if (isSwiftVideoValidatorUnavailable(result.stderr, result.stdout))
    throw unavailableVideoValidator();
  return result.exitCode === 0;
}

/**
 * Polls until the file plays, for `attempts` polls or until `deadline` passes, whichever is first,
 * and resolves whether it played.
 */
export async function waitForPlayableVideo(
  filePath: string,
  options: {
    validator: PreparedVideoValidator | undefined;
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
  return /\b(no such module ['"]AVFoundation['"]|unable to find utility ["']swiftc?["']|xcrun: error: unable to find utility ["']swiftc?["'])/i.test(
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
