import fs from 'node:fs';
import { findMp4Atom } from './mp4-atoms.ts';

const MVHD = ['moov', 'mvhd'] as const;
const MVHD_TIMESCALE_VERSION_0 = 12;
const MVHD_DURATION_VERSION_0 = 16;
const MVHD_TIMESCALE_VERSION_1 = 20;
const MVHD_DURATION_VERSION_1 = 24;
const MVHD_FIXED_LAYOUT_BYTES = 32;
const UNKNOWABLE_32_BIT_DURATION = 0xffffffff;

/**
 * Duration the MP4 timeline actually covers, in milliseconds, or `undefined` when the container
 * cannot answer. A screen-recording timeline can be shorter than the window it was captured in:
 * `screenrecord` encodes a frame only when the screen changes.
 */
export function readMp4DurationMs(filePath: string): number | undefined {
  const header = readMovieHeader(filePath);
  if (!header) return undefined;
  const version = header[0];
  if (version === 1) {
    return movieDurationMs(
      header.readUInt32BE(MVHD_TIMESCALE_VERSION_1),
      Number(header.readBigUInt64BE(MVHD_DURATION_VERSION_1)),
    );
  }
  if (version !== 0) return undefined;
  const duration = header.readUInt32BE(MVHD_DURATION_VERSION_0);
  if (duration === UNKNOWABLE_32_BIT_DURATION) return undefined;
  return movieDurationMs(header.readUInt32BE(MVHD_TIMESCALE_VERSION_0), duration);
}

function movieDurationMs(timescale: number, duration: number): number | undefined {
  // Zero is a real timeline: a clip of a screen that never changed holds one frame.
  if (timescale <= 0 || duration < 0 || !Number.isSafeInteger(duration)) return undefined;
  return Math.round((duration * 1000) / timescale);
}

function readMovieHeader(filePath: string): Buffer | undefined {
  const movieHeader = findMp4Atom(filePath, MVHD);
  if (!movieHeader || !Number.isSafeInteger(movieHeader.size)) return undefined;
  const payloadOffset = movieHeader.offset + movieHeader.headerSize;
  if (movieHeader.size - movieHeader.headerSize < MVHD_FIXED_LAYOUT_BYTES) return undefined;
  const buffer = Buffer.alloc(MVHD_FIXED_LAYOUT_BYTES);
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    return fs.readSync(fd, buffer, 0, buffer.length, payloadOffset) === buffer.length
      ? buffer
      : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
