import fs from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { sleep } from '@agent-device/host-kit/retry';
import { buildSwiftToolEnv, compileSwiftSourceText } from './swift-cache.ts';

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

let videoValidatorExecutablePathPromise: Promise<string> | undefined;

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

export async function isPlayableVideo(filePath: string): Promise<boolean> {
  const container = await likelyPlayableVideoContainer(filePath);
  if (!container) return false;
  // AVFoundation is the MP4 semantic validator. It does not reliably load WebM on supported
  // macOS hosts, so WebM completion is established by its EBML document type + Segment marker.
  if (container === 'webm') return true;
  try {
    const validatorPath = await getVideoValidatorExecutablePath();
    const result = await runCmd(validatorPath, [filePath], {
      allowFailure: true,
      timeoutMs: 10_000,
      env: buildSwiftToolEnv(),
    });
    if (result.exitCode === 0) {
      return true;
    }
    return isSwiftVideoValidatorUnavailable(result.stderr, result.stdout);
  } catch (error) {
    if (isSwiftVideoValidatorError(error)) {
      return true;
    }
    throw error;
  }
}

async function getVideoValidatorExecutablePath(): Promise<string> {
  videoValidatorExecutablePathPromise ??= compileSwiftSourceText({
    source: VIDEO_VALIDATION_SCRIPT,
    cacheName: 'video-validator',
    timeoutMs: 30_000,
  });
  try {
    return await videoValidatorExecutablePathPromise;
  } catch (error) {
    videoValidatorExecutablePathPromise = undefined;
    throw error;
  }
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

export async function waitForPlayableVideo(
  filePath: string,
  options: { pollMs?: number; attempts?: number } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 150;
  const attempts = options.attempts ?? 12;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isPlayableVideo(filePath)) {
      return;
    }
    await sleep(pollMs);
  }
}

function isSwiftVideoValidatorUnavailable(stderr: string, stdout: string): boolean {
  const combined = `${stderr}\n${stdout}`;
  return /\b(no such module ['"]AVFoundation['"]|unable to find utility ["']swiftc?["']|xcrun: error: unable to find utility ["']swiftc?["'])\b/i.test(
    combined,
  );
}

/**
 * The container sniff alone: `ftyp` and `moov` for MP4, the EBML segment for WebM. It reads the file and
 * spawns nothing, which is what lets a stop check a copy before it trusts it (ADR 0024 2.3).
 */
export async function hasVideoContainer(filePath: string): Promise<boolean> {
  return (await likelyPlayableVideoContainer(filePath)) !== undefined;
}

async function likelyPlayableVideoContainer(filePath: string): Promise<'mp4' | 'webm' | undefined> {
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
