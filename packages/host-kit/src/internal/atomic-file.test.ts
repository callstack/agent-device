import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { publishFileSync } from './atomic-file.ts';

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

    const siblings = fs.readdirSync(directory).filter((name) => name.startsWith('clean.txt.'));
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
          .filter((name) => name.startsWith('permission-update-failed.png.')),
      ).toEqual([]);
    } finally {
      chmod.mockRestore();
    }
  });
});
