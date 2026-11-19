import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import {
  isAtomicPublishTemporaryPath,
  publishFileSync,
  withAtomicPublishTempPathSync,
} from './atomic-publish.ts';

const directory = mkdtempForTestSync('host-kit-atomic-file-');

function destination(name: string): string {
  return path.join(directory, name);
}

describe('publishFileSync', () => {
  test('writes text as UTF-8', () => {
    const target = destination('note.json');
    publishFileSync({ destination: target, contents: '{"ok":true,"mark":"é"}' });

    expect(fs.readFileSync(target, 'utf8')).toBe('{"ok":true,"mark":"é"}');
  });

  test('writes bytes exactly as the caller built them', () => {
    // PNG magic plus bytes a UTF-8 round trip would not hand back unchanged.
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xc3, 0x28]);
    const target = destination('sheet.png');
    publishFileSync({ destination: target, contents: bytes });

    expect([...fs.readFileSync(target)]).toEqual([...bytes]);
  });

  test('replaces what was already published at the destination', () => {
    const target = destination('replaced.txt');
    publishFileSync({ destination: target, contents: 'first' });
    publishFileSync({ destination: target, contents: Uint8Array.from([2, 3, 4]) });

    expect([...fs.readFileSync(target)]).toEqual([2, 3, 4]);
  });

  test('leaves no staging file beside what it published', () => {
    const target = destination('clean.txt');
    publishFileSync({ destination: target, contents: 'body' });

    const siblings = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith('.clean.txt.') && name.endsWith('.tmp'));
    expect(siblings).toEqual([]);
  });

  test.skipIf(process.platform === 'win32').each([0o600, 0o640])(
    'preserves existing mode %s before replacing its contents',
    (mode) => {
      const target = destination(`private-${mode}.png`);
      fs.writeFileSync(target, 'private old bytes');
      fs.chmodSync(target, mode);
      const previousUmask = process.umask(0o077);
      try {
        publishFileSync({
          destination: target,
          contents: 'private new bytes',
          preserveExistingMode: true,
        });
        expect(fs.readFileSync(target, 'utf8')).toBe('private new bytes');
        expect(fs.statSync(target).mode & 0o777).toBe(mode);
      } finally {
        process.umask(previousUmask);
      }
    },
  );

  test('creates an absent destination when existing-mode preservation is requested', () => {
    const target = destination('previously-absent.png');
    publishFileSync({ destination: target, contents: 'new bytes', preserveExistingMode: true });
    expect(fs.readFileSync(target, 'utf8')).toBe('new bytes');
  });

  test.skipIf(process.platform === 'win32')('pays an asked-for mode with the umask', () => {
    // A generic caller gets `mode` ANDed with the umask, because that is what a CREATE answers and it is what
    // every caller of this function has had since the function existed: 0600 under umask 0200 is 0400. Only
    // `exactMode` asks for the number, and only the script publisher does.
    const target = destination('umask-priced.png');
    const previousUmask = process.umask(0o0200);
    try {
      publishFileSync({ destination: target, contents: 'bytes', mode: 0o600 });
      expect(fs.statSync(target).mode & 0o777).toBe(0o400);
    } finally {
      process.umask(previousUmask);
    }
  });

  test.skipIf(process.platform === 'win32')(
    'makes the mode exact when the caller asks for the number',
    () => {
      const target = destination('exact-mode.png');
      const previousUmask = process.umask(0o0200);
      try {
        publishFileSync({ destination: target, contents: 'bytes', mode: 0o600, exactMode: true });
        expect(fs.statSync(target).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(previousUmask);
      }
    },
  );

  test('a failed permission update leaves the existing destination unchanged', () => {
    const target = destination('permission-update-failed.png');
    fs.writeFileSync(target, 'old bytes');
    const failure = new Error('permission update failed');
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw failure;
    });
    try {
      expect(() =>
        publishFileSync({ destination: target, contents: 'new bytes', preserveExistingMode: true }),
      ).toThrow(failure);
      expect(fs.readFileSync(target, 'utf8')).toBe('old bytes');
      expect(
        fs
          .readdirSync(directory)
          .filter(
            (name) => name.startsWith('.permission-update-failed.png.') && name.endsWith('.tmp'),
          ),
      ).toEqual([]);
    } finally {
      chmod.mockRestore();
    }
  });
});

test('a temp sibling belongs to its own destination even when another name shares its first 64 bytes', () => {
  const shared = 'a'.repeat(64);
  const first = path.join('/recordings', `${shared}-first.ad`);
  const second = path.join('/recordings', `${shared}-second.ad`);
  const sibling = withAtomicPublishTempPathSync(first, (temporaryPath) => temporaryPath);

  expect(isAtomicPublishTemporaryPath(sibling, first)).toBe(true);
  expect(isAtomicPublishTemporaryPath(sibling, second)).toBe(false);
  expect(Buffer.byteLength(path.basename(sibling))).toBeLessThan(128);
});

test('a short name keeps its temp sibling no longer than the release format made it', () => {
  // The release format was `.<name>.<pid>-<uuid>.tmp`; a deep directory near PATH_MAX left no room for more.
  const destination = path.join('/recordings', 'x.png');
  const release = `.x.png.${process.pid}-${'0'.repeat(36)}.tmp`;
  const sibling = withAtomicPublishTempPathSync(destination, (temporaryPath) => temporaryPath);

  expect(Buffer.byteLength(path.basename(sibling))).toBeLessThanOrEqual(Buffer.byteLength(release));
});

test('a temp sibling repeats at most 32 bytes of a long name', () => {
  const sibling = withAtomicPublishTempPathSync(
    path.join('/recordings', `${'a'.repeat(64)}.ad`),
    (temporaryPath) => temporaryPath,
  );

  expect(path.basename(sibling).split('.')[1]).toBe('a'.repeat(32));
});

test('two names whose hashes agree in their first 12 hex digits keep separate temp siblings', () => {
  const first = path.join('/recordings', `${'a'.repeat(32)}001b3611.ad`);
  const second = path.join('/recordings', `${'a'.repeat(32)}013aae72.ad`);
  const sibling = withAtomicPublishTempPathSync(first, (temporaryPath) => temporaryPath);

  expect(isAtomicPublishTemporaryPath(sibling, first)).toBe(true);
  expect(isAtomicPublishTemporaryPath(sibling, second)).toBe(false);
});

test('a temp stem counts bytes, keeping 16 two-byte characters of a long name', () => {
  const sibling = withAtomicPublishTempPathSync(
    path.join('/recordings', `${'é'.repeat(32)}.ad`),
    (temporaryPath) => temporaryPath,
  );

  expect(path.basename(sibling).split('.')[1]).toBe('é'.repeat(16));
});
