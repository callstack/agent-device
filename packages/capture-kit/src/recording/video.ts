import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { isCommandTimeoutError, runCmd } from '@agent-device/host-kit/command';
import { type Deadline, sleep } from '@agent-device/host-kit/retry';
import { buildSwiftToolEnv, compileSwiftSourceText, getSwiftCacheRoot } from './swift-cache.ts';
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

// A cold Swift module cache makes the validator compile take over 30 s on a loaded CI runner, so a
// caller with a deadline, such as `record stop`, waits for the compile until that deadline instead.
const VALIDATOR_COMPILE_WAIT_MS = 30_000;
const VALIDATOR_RUN_TIMEOUT_MS = 10_000;

const videoValidatorCompiles = new Map<string, Promise<string>>();

/** Starts one cached compile per Swift cache root. Callers may warm it without awaiting it. */
export function prepareVideoValidator(host: HostEnvironment): Promise<string> {
  const cacheRoot = getSwiftCacheRoot(host.env);
  let compiled = videoValidatorCompiles.get(cacheRoot);
  if (!compiled) {
    compiled = compileSwiftSourceText({
      host,
      source: VIDEO_VALIDATION_SCRIPT,
      cacheName: 'video-validator',
    }).catch((error: unknown) => {
      if (videoValidatorCompiles.get(cacheRoot) === compiled)
        videoValidatorCompiles.delete(cacheRoot);
      throw unavailableVideoValidator(error);
    });
    videoValidatorCompiles.set(cacheRoot, compiled);
  }
  return compiled;
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

/**
 * Whether the file is a playable video. With a `deadline`, a cold validator compile runs until the
 * deadline instead of its own fixed bound. A validator run that times out, or that the deadline
 * leaves no time for, reads as not playable, like a poll in `waitForPlayableVideo` that runs out of
 * time. A WebM
 * verdict reads only the file's structure, with no validator, so the deadline does not apply to it.
 */
export async function isPlayableVideo(
  filePath: string,
  host: HostEnvironment,
  deadline?: Deadline,
): Promise<boolean> {
  const container = await readVideoContainerKind(filePath);
  if (!container) return false;
  // AVFoundation is the MP4 semantic validator. It does not reliably load WebM on supported
  // macOS hosts, so WebM completion is established by its EBML document type + Segment marker.
  if (container === 'webm') return true;
  try {
    if (deadline?.isExpired()) return false;
    const validatorPath = await waitForValidatorCompile(
      host,
      deadline?.remainingMs() ?? VALIDATOR_COMPILE_WAIT_MS,
    ).catch((error: unknown) => {
      if (
        error instanceof AppError &&
        error.cause instanceof AppError &&
        error.cause.code === 'TOOL_MISSING'
      )
        return undefined;
      throw error;
    });
    // Without compiler-launch tooling, MP4 completion relies on the container check.
    if (!validatorPath) return true;
    const runTimeoutMs = Math.min(
      VALIDATOR_RUN_TIMEOUT_MS,
      deadline?.remainingMs() ?? VALIDATOR_RUN_TIMEOUT_MS,
    );
    // A budget with no time left reads as not playable; `runCmd` would read a timeout of 0 as none.
    if (runTimeoutMs <= 0) return false;
    const result = await runCmd(validatorPath, [filePath], {
      allowFailure: true,
      timeoutMs: runTimeoutMs,
      env: buildSwiftToolEnv(host.env),
    }).catch((error: unknown) => {
      if (isCommandTimeoutError(error)) return undefined;
      throw error;
    });
    if (!result) return false;
    if (result.exitCode === 0) {
      return true;
    }
    if (isSwiftVideoValidatorUnavailable(result.stderr, result.stdout)) {
      throw unavailableVideoValidator(new AppError('COMMAND_FAILED', result.stderr));
    }
    return false;
  } catch (error) {
    if (isSwiftVideoValidatorError(error)) {
      throw unavailableVideoValidator(error);
    }
    throw error;
  }
}

async function waitForValidatorCompile(host: HostEnvironment, waitMs: number): Promise<string> {
  const compiled = prepareVideoValidator(host);
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new AppError(
            'COMMAND_FAILED',
            `The video validator did not compile within ${Math.round(waitMs)}ms`,
            {
              reason: 'video_validator_compile_timeout',
              timeoutMs: waitMs,
              retriable: true,
              hint:
                'Run record stop again: the validator compile continues in the background, ' +
                'and the recording keeps its evidence.',
            },
          ),
        ),
      waitMs,
    );
  });
  try {
    return await Promise.race([compiled, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailableVideoValidator(cause: unknown): AppError {
  if (cause instanceof AppError && cause.details?.reason === 'video_validator_unavailable')
    return cause;
  const details = cause instanceof AppError ? cause.details : undefined;
  return new AppError(
    'COMMAND_FAILED',
    'The video validator is unavailable; MP4 playability could not be verified.',
    {
      ...details,
      reason: 'video_validator_unavailable',
      retriable: false,
      hint:
        details?.hint ??
        (isSwiftVideoValidatorUnavailable(details?.stderr ?? '', details?.stdout ?? '')
          ? 'Ensure Swift and AVFoundation are available on the daemon host, then retry record stop.'
          : 'Repair the Swift toolchain or validator executable on the daemon host, then retry record stop.'),
    },
    cause,
  );
}

function isSwiftVideoValidatorError(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }
  if (error.code === 'TOOL_MISSING') {
    return true;
  }
  return isSwiftVideoValidatorUnavailable(
    String(error.details?.stderr ?? ''),
    String(error.details?.stdout ?? ''),
  );
}

/**
 * Polls until the file plays, for `attempts` polls or until `deadline` passes, whichever is first,
 * and resolves whether it played.
 */
export async function waitForPlayableVideo(
  filePath: string,
  options: { host: HostEnvironment; pollMs?: number; attempts?: number; deadline?: Deadline },
): Promise<boolean> {
  const pollMs = options.pollMs ?? 150;
  const attempts = options.attempts ?? 12;

  for (let attempt = 1; ; attempt += 1) {
    if (await isPlayableVideo(filePath, options.host, options.deadline)) {
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
