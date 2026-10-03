import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { readMp4DurationMs } from './mp4-duration.ts';
import { mp4Atom, mp4MovieHeader } from './mp4.fixtures.ts';

const directory = mkdtempForTestSync('agent-device-mp4-duration-');

function recording(name: string, movieHeaderPayload: Buffer): string {
  const filePath = path.join(directory, `${name}.mp4`);
  fs.writeFileSync(
    filePath,
    Buffer.concat([
      mp4Atom('ftyp', Buffer.alloc(24)),
      mp4Atom('mdat', Buffer.alloc(16)),
      mp4Atom('moov', mp4Atom('mvhd', movieHeaderPayload)),
    ]),
  );
  return filePath;
}

describe('readMp4DurationMs', () => {
  test('reads a version 0 movie header in its own timescale', () => {
    const file = recording(
      'v0',
      mp4MovieHeader({ version: 0, timescale: 90_000, duration: 630_000 }),
    );
    expect(readMp4DurationMs(file)).toBe(7_000);
  });

  test('reports a timeline of zero for a clip of a screen that never changed', () => {
    const file = recording('static', mp4MovieHeader({ version: 0, timescale: 1_000, duration: 0 }));
    expect(readMp4DurationMs(file)).toBe(0);
  });

  test('reads the 64-bit duration of a version 1 movie header', () => {
    const file = recording('v1', mp4MovieHeader({ version: 1, timescale: 1_000, duration: 9_500 }));
    expect(readMp4DurationMs(file)).toBe(9_500);
  });

  test('rounds a duration that does not divide evenly into milliseconds', () => {
    const file = recording('odd', mp4MovieHeader({ version: 0, timescale: 3, duration: 2 }));
    expect(readMp4DurationMs(file)).toBe(667);
  });

  test('answers undefined when the timeline cannot be trusted', () => {
    expect(
      readMp4DurationMs(
        recording('idle', mp4MovieHeader({ version: 0, timescale: 1_000, duration: 0xffff_ffff })),
      ),
    ).toBeUndefined();
    expect(
      readMp4DurationMs(
        recording('no-timescale', mp4MovieHeader({ version: 0, timescale: 0, duration: 5_000 })),
      ),
    ).toBeUndefined();
    const unsupportedVersion = mp4MovieHeader({ version: 0, timescale: 1_000, duration: 5_000 });
    unsupportedVersion.writeUInt8(2, 0);
    expect(readMp4DurationMs(recording('version-2', unsupportedVersion))).toBeUndefined();
  });

  test('answers undefined for a file with no movie header or a truncated one', () => {
    const withoutMovieHeader = path.join(directory, 'no-moov.mp4');
    fs.writeFileSync(withoutMovieHeader, mp4Atom('mdat', Buffer.alloc(16)));
    expect(readMp4DurationMs(withoutMovieHeader)).toBeUndefined();

    const truncated = path.join(directory, 'truncated.mp4');
    fs.writeFileSync(truncated, mp4Atom('moov', mp4Atom('mvhd', Buffer.alloc(24))));
    expect(readMp4DurationMs(truncated)).toBeUndefined();
  });
});
