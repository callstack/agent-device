import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { findMp4Atom } from './mp4-atoms.ts';
import { mp4Atom, mp4AtomWithExtendedSize } from './mp4.fixtures.ts';

const directory = mkdtempForTestSync('agent-device-mp4-atoms-');

function write(name: string, contents: Buffer): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, contents);
  return filePath;
}

describe('findMp4Atom', () => {
  test('locates a nested box and reports where its payload starts', () => {
    const movieHeader = mp4Atom('mvhd', Buffer.alloc(100));
    const file = write(
      'nested.mp4',
      Buffer.concat([mp4Atom('ftyp', Buffer.alloc(8)), mp4Atom('moov', movieHeader)]),
    );
    const atom = findMp4Atom(file, ['moov', 'mvhd']);
    expect(atom?.type).toBe('mvhd');
    expect(atom?.offset).toBe(24);
    expect(atom?.size).toBe(108);
    expect(findMp4Atom(file, ['moov', 'udta'])).toBeUndefined();
  });

  test('walks past a 64-bit sized box', () => {
    const file = write(
      'extended.mp4',
      Buffer.concat([
        mp4AtomWithExtendedSize('mdat', Buffer.alloc(64)),
        mp4Atom('moov', Buffer.alloc(16)),
      ]),
    );
    expect(findMp4Atom(file, ['moov'])?.offset).toBe(16 + 64);
  });

  test('accepts a box whose declared size runs to end of file', () => {
    const streamingMdat = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mdat', 'latin1'),
      Buffer.alloc(32),
    ]);
    const file = write(
      'streaming.mp4',
      Buffer.concat([mp4Atom('ftyp', Buffer.alloc(8)), streamingMdat]),
    );
    const atom = findMp4Atom(file, ['mdat']);
    expect(atom?.offset).toBe(16);
    expect(atom?.size).toBe(streamingMdat.length);
  });

  test('reports a box that overruns its container and stops looking past it', () => {
    const overrunning = Buffer.concat([
      Buffer.from([0, 0, 0, 200]),
      Buffer.from('wide', 'latin1'),
      Buffer.alloc(40),
    ]);
    const file = write(
      'overrun.mp4',
      Buffer.concat([
        mp4Atom('ftyp', Buffer.alloc(8)),
        overrunning,
        mp4Atom('moov', Buffer.alloc(8)),
      ]),
    );
    expect(findMp4Atom(file, ['wide'])?.size).toBe(200);
    expect(findMp4Atom(file, ['moov'])).toBeUndefined();
  });

  test('answers undefined for an absent file, an unreadable path, and a short box', () => {
    expect(findMp4Atom(path.join(directory, 'absent.mp4'), ['moov'])).toBeUndefined();
    expect(findMp4Atom(directory, ['moov'])).toBeUndefined();
    expect(findMp4Atom(write('short.mp4', Buffer.from([0, 0])), ['moov'])).toBeUndefined();
  });
});
