import fs from 'node:fs';
import path from 'node:path';
import { encodePngPixels } from '../png-encode.ts';
import type { PNG } from '../png.ts';

/**
 * The frame helper's side of a conversation, replayed against a scratch directory. Frames are
 * written as the PNG bytes a real decoder hands back, so the pipeline decodes them the same way it
 * decodes a simulator's recording.
 */

/** A frame the fake decoder answers with: the pixels plus the time it claims to carry. */
export type StubFrame = Readonly<{ png: PNG; actualTimeMs: number }>;

export type StubDecoderResult = Readonly<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/**
 * Answers the frame helper's argv by writing PNG files where it was told to write them and
 * returning the manifest the real helper prints. A requested time with no stub frame is reported
 * as skipped, exactly as a decoder that declines a request is.
 */
export function writeDecodedFrames(
  input: Readonly<{
    args: readonly string[];
    framesByRequestedTimeMs: ReadonlyMap<number, StubFrame>;
    failWithExitCode?: number;
    manifest?: string;
  }>,
): StubDecoderResult {
  if (input.failWithExitCode !== undefined) {
    return {
      stdout: '',
      stderr: 'recording-frames: could not open asset',
      exitCode: input.failWithExitCode,
    };
  }
  if (input.manifest !== undefined) {
    return { stdout: input.manifest, stderr: '', exitCode: 0 };
  }

  const outputDir = requireOption(input.args, '--output-dir');
  const requestedTimes = parseTimes(requireOption(input.args, '--times'));
  const frames: unknown[] = [];
  const skipped: unknown[] = [];

  requestedTimes.forEach((requestedTimeMs, index) => {
    const frame = input.framesByRequestedTimeMs.get(requestedTimeMs);
    if (!frame) {
      skipped.push({ index, requestedTimeMs, reason: 'no frame at time' });
      return;
    }
    const filePath = path.join(outputDir, frameFileName(index));
    fs.writeFileSync(
      filePath,
      encodePngPixels(frame.png.data, frame.png.width, frame.png.height, 4),
    );
    frames.push({
      index,
      requestedTimeMs,
      actualTimeMs: frame.actualTimeMs,
      width: frame.png.width,
      height: frame.png.height,
      path: filePath,
    });
  });

  return {
    stdout: JSON.stringify({ inputPath: 'fixture.mp4', durationMs: 0, frames, skipped }),
    stderr: '',
    exitCode: 0,
  };
}

function frameFileName(index: number): string {
  return `frame-${String(index).padStart(4, '0')}.png`;
}

function requireOption(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value) throw new Error(`fixture decoder was called without ${flag}`);
  return value;
}

function parseTimes(value: string): number[] {
  return value
    .split(',')
    .filter((part) => part !== '')
    .map(Number);
}
