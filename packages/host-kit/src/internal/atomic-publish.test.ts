import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import { isAtomicPublishTemporaryPath, publishFileSync } from './atomic-publish.ts';

function stagedSibling(destination: string): string {
  const rename = vi.spyOn(fs, 'renameSync');
  try {
    publishFileSync({ destination, contents: 'test' });
    return String(rename.mock.calls[0]?.[0]);
  } finally {
    rename.mockRestore();
  }
}

const directory = mkdtempForTestSync('host-kit-atomic-publish-');

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

  test('a sibling the host gives no identity for is left, not removed on the claim alone', () => {
    // The name embedding this pid and a fresh UUID proves nobody else's entry stood there WHEN the create ran.
    // It says nothing about what stands there NOW: an entry swapped into the name since then is somebody else's,
    // and a `rm` at that path would remove it. With no identity from the open descriptor there is no way to tell
    // this call's entry from that one, so the cleanup answers a skip. A `link-exclusive` publish leaves the
    // sibling standing by design, which is where the skip is visible.
    const target = destination('unidentified.ad');
    const fstat = vi.spyOn(fs, 'fstatSync').mockImplementation((() => {
      throw Object.assign(new Error('ENOSYS'), { code: 'ENOSYS' });
    }) as unknown as typeof fs.fstatSync);

    try {
      publishFileSync({
        destination: target,
        contents: 'bytes',
        publish: 'link-exclusive',
      });
    } finally {
      fstat.mockRestore();
    }

    expect(fs.readFileSync(target, 'utf8')).toBe('bytes');
    expect(
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('.unidentified.ad.') && name.endsWith('.tmp')),
    ).toHaveLength(1);
  });

  test('a sibling this call holds the identity of is tidied after the same publish', () => {
    // The closest negative, and the ordinary route: the host answers an identity, the name still answers that
    // one, and the sibling this call made is this call to remove.
    const target = destination('identified.ad');

    publishFileSync({ destination: target, contents: 'bytes', publish: 'link-exclusive' });

    expect(fs.readFileSync(target, 'utf8')).toBe('bytes');
    expect(
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('.identified.ad.') && name.endsWith('.tmp')),
    ).toEqual([]);
  });

  test('a sibling replaced by another entry while it was staged is left to its new owner', () => {
    // The window the identity is asked for: after this call's create, another process puts an entry of its own
    // at the sibling's name. The `lstat` of the NAME then answers a DIFFERENT inode from the open descriptor,
    // and that entry is its owner's to keep — removing it would destroy their file to tidy up after this call.
    // The publish's own failure stays the answer the caller gets.
    const target = destination('swapped-under-sibling.txt');
    const realOpenSync = fs.openSync.bind(fs);
    let planted = false;
    const openSync = vi.spyOn(fs, 'openSync').mockImplementation(((
      name: unknown,
      ...rest: unknown[]
    ) => {
      const descriptor = (realOpenSync as (...args: unknown[]) => number)(name, ...rest);
      if (!planted && typeof name === 'string' && name.endsWith('.tmp')) {
        planted = true;
        fs.rmSync(name, { force: true });
        fs.writeFileSync(name, 'theirs\n');
      }
      return descriptor;
    }) as typeof fs.openSync);

    try {
      expect(() =>
        publishFileSync({
          destination: target,
          contents: 'bytes',
          assertDestination: () => {
            throw new Error('the destination is not this call to replace');
          },
        }),
      ).toThrow(/not this call to replace/);
    } finally {
      openSync.mockRestore();
    }

    const siblings = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith('.swapped-under-sibling.txt.') && name.endsWith('.tmp'));
    expect(siblings).toHaveLength(1);
    expect(fs.readFileSync(path.join(directory, siblings[0]!), 'utf8')).toBe('theirs\n');
    expect(fs.existsSync(target)).toBe(false);
  });

  test('a staging sibling is not tidied out of ground the caller no longer holds', () => {
    // The sibling this call created is its own to delete only while the DIRECTORY holding it is still the one
    // the caller judged. A directory renamed away and made again meanwhile belongs to whoever owns that ground
    // now, so a `rm` at the spelled sibling path would remove an entry this call has no authority over — and
    // would destroy the only evidence of the failed write. The cleanup therefore asks the caller's own
    // directory judgment first, and skips when it no longer holds.
    const target = destination('held.txt');
    const siblings = () =>
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('.held.txt.') && name.endsWith('.tmp'));

    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(((written: unknown) => {
      if (typeof written === 'number') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      throw new Error('unexpected plain write');
    }) as typeof fs.writeFileSync);

    try {
      expect(() =>
        publishFileSync({
          destination: target,
          contents: 'bytes',
          assertStagedIn: () => {
            throw new Error('the judged directory is gone');
          },
        }),
      ).toThrow(/ENOSPC/);
      expect(siblings().length).toBe(1);
    } finally {
      write.mockRestore();
      for (const name of siblings()) fs.rmSync(path.join(directory, name), { force: true });
    }
  });

  test('a failed publish whose directory still holds leaves no sibling behind', () => {
    // The other side of the same gate: an ordinary write failure is tidied, because the caller's own
    // directory judgment still answers the ground it judged.
    const target = destination('tidied.txt');
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(((written: unknown) => {
      if (typeof written === 'number') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      throw new Error('unexpected plain write');
    }) as typeof fs.writeFileSync);

    try {
      expect(() =>
        publishFileSync({
          destination: target,
          contents: 'bytes',
          assertStagedIn: () => {},
        }),
      ).toThrow(/ENOSPC/);
    } finally {
      write.mockRestore();
    }

    expect(
      fs
        .readdirSync(directory)
        .filter((name) => name.startsWith('.tidied.txt.') && name.endsWith('.tmp')),
    ).toEqual([]);
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

  test.skipIf(process.platform === 'win32')(
    'publishes with NO mode asked at the mode the umask gives, as it always did',
    () => {
      // What the exclusive create must not do is quietly make every artifact private. A contact sheet a daemon
      // publishes and a CI account reads lands 0644 under umask 022; a caller that wants 0600 ASKS for it, the
      // way a state record does.
      const target = destination('umask-governed.png');
      const previousUmask = process.umask(0o022);
      try {
        publishFileSync({ destination: target, contents: 'bytes' });
        expect(fs.statSync(target).mode & 0o777).toBe(0o644);
      } finally {
        process.umask(previousUmask);
      }
    },
  );

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
    // The mode is said on the OPEN sibling descriptor, never at a name, so this is the seam a host's
    // permission update fails at.
    const fchmod = vi.spyOn(fs, 'fchmodSync').mockImplementation(() => {
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
      fchmod.mockRestore();
    }
  });
});

test('a temp sibling belongs to its own destination even when another name shares its first 64 bytes', () => {
  const shared = 'a'.repeat(64);
  const first = path.join(directory, `${shared}-first.ad`);
  const second = path.join(directory, `${shared}-second.ad`);
  const sibling = stagedSibling(first);

  expect(isAtomicPublishTemporaryPath(sibling, first)).toBe(true);
  expect(isAtomicPublishTemporaryPath(sibling, second)).toBe(false);
  expect(Buffer.byteLength(path.basename(sibling))).toBeLessThan(128);
});

test('a short name keeps its temp sibling no longer than the release format made it', () => {
  // The release format was `.<name>.<pid>-<uuid>.tmp`; a deep directory near PATH_MAX left no room for more.
  const destination = path.join(directory, 'x.png');
  const release = `.x.png.${process.pid}-${'0'.repeat(36)}.tmp`;
  const sibling = stagedSibling(destination);

  expect(Buffer.byteLength(path.basename(sibling))).toBeLessThanOrEqual(Buffer.byteLength(release));
});

test('a temp sibling repeats at most 32 bytes of a long name', () => {
  const sibling = stagedSibling(path.join(directory, `${'a'.repeat(64)}.ad`));

  expect(path.basename(sibling).split('.')[1]).toBe('a'.repeat(32));
});

test('two names whose hashes agree in their first 12 hex digits keep separate temp siblings', () => {
  const first = path.join(directory, `${'a'.repeat(32)}001b3611.ad`);
  const second = path.join(directory, `${'a'.repeat(32)}013aae72.ad`);
  const sibling = stagedSibling(first);

  expect(isAtomicPublishTemporaryPath(sibling, first)).toBe(true);
  expect(isAtomicPublishTemporaryPath(sibling, second)).toBe(false);
});

test('a temp stem counts bytes, keeping 16 two-byte characters of a long name', () => {
  const sibling = stagedSibling(path.join(directory, `${'é'.repeat(32)}.ad`));

  expect(path.basename(sibling).split('.')[1]).toBe('é'.repeat(16));
});
