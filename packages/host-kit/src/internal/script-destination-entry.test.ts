// The final name a script destination is created under: host-kit validates it before any filesystem work and
// answers the complete entry, so no publisher spells a name the walk did not authorize (ADR 0016).
import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ancestryRoot as root,
  directoryWith,
  expectUntrusted,
  expectUntrustedReplaced,
  publish,
  skipOnWindows,
  tree,
} from './script-destination-host.fixtures.ts';
import {
  confirmScriptDestination,
  prepareScriptDestination,
  publishScriptFileSync,
} from './script-destination.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

skipOnWindows.each([
  { name: 'a `.` final segment', suffix: '/.' },
  { name: 'a `..` final segment', suffix: '/..' },
  { name: 'a `.` below a missing directory', suffix: '/sub/.' },
  { name: 'a `..` below a missing directory', suffix: '/sub/..' },
  { name: 'a NUL in the final name', suffix: '/journey\0.ad' },
  { name: 'a NUL in a missing directory', suffix: '/sub\0/journey.ad' },
  { name: 'a 256-byte name below a missing directory', suffix: `/new/${'a'.repeat(256)}` },
  { name: 'a 256-byte name of two-byte characters', suffix: `/new/${'é'.repeat(128)}` },
])('refuses $name before anything is created', ({ suffix }) => {
  const directory = root();
  const dir = directoryWith(path.join(directory, 'dir'), 0o700);
  const destination = `${dir}${suffix}`;

  expectUntrusted(() => publish(destination), 'unnamed_entry', path.dirname(destination));
  expectUntrusted(
    () => prepareScriptDestination(destination),
    'unnamed_entry',
    path.dirname(destination),
  );
  expect(tree(directory)).toEqual(['dir']);
});

test('refuses the root itself, whose final name is empty', () => {
  expectUntrusted(() => prepareScriptDestination('/'), 'unnamed_entry', '/');
});

skipOnWindows(
  'never writes a temporary file outside the judged directory for a `..` final segment',
  () => {
    // `<dir>/inner/..` spells `inner` as the parent. An entry joined from that parent and `..` is `<dir>`
    // itself, and its temporary sibling would land one level further up, in ground nobody judged as the place
    // the entry is created.
    const directory = root();
    const dir = directoryWith(path.join(directory, 'dir'), 0o700);
    const inner = directoryWith(path.join(dir, 'inner'), 0o700);
    const written: string[] = [];
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...rest) => {
      written.push(String(target));
      return write(target, ...rest);
    });

    expect(() => publish(`${inner}/..`)).toThrow();

    expect(written.filter((target) => path.dirname(target) !== inner)).toEqual([]);
    expectUntrusted(() => publish(`${inner}/..`), 'unnamed_entry', inner);
    expect(tree(directory)).toEqual(['dir', path.join('dir', 'inner')]);
  },
);

skipOnWindows.each([220, 255])('a %i-byte name publishes, its temp sibling included', (bytes) => {
  const directory = root();
  const dir = directoryWith(path.join(directory, 'dir'), 0o700);
  const name = 'a'.repeat(bytes);

  publish(path.join(dir, name));

  expect(tree(dir)).toEqual([name]);
});

skipOnWindows('a trailing separator names the same entry it always has', () => {
  const directory = root();
  const dir = directoryWith(path.join(directory, 'dir'), 0o700);

  publish(`${dir}/journey.ad/`);

  expect(fs.readFileSync(path.join(dir, 'journey.ad'), 'utf8')).toBe('context\n');
  expect(tree(dir)).toEqual(['journey.ad']);
  expect(prepareScriptDestination(`${dir}/journey.ad/`).entry).toBe(path.join(dir, 'journey.ad'));
});

test('a relative destination is refused as relative, whatever its last segment', () => {
  expectUntrusted(
    () => prepareScriptDestination('recordings/..'),
    'relative_destination',
    'recordings',
  );
});

function onWindows<T>(task: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    return task();
  } finally {
    Object.defineProperty(process, 'platform', original!);
  }
}

test('a Windows confirmation refuses a different directory under the one identity Windows answers', () => {
  const volume = fs.statSync(root());
  vi.spyOn(fs, 'statSync').mockReturnValue(volume);
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  onWindows(() => {
    const prepared = prepareScriptDestination(String.raw`C:\judged\journey.ad`);
    expectUntrustedReplaced(
      () => confirmScriptDestination(String.raw`C:\other\journey.ad`, prepared),
      String.raw`C:\other`,
    );
  });
});

test('a script publishes at a Windows drive root without creating the volume', () => {
  const volume = fs.statSync(root());
  const stat = vi.spyOn(fs, 'statSync').mockReturnValue(volume);
  const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
    throw Object.assign(new Error('Cannot create the Windows volume root'), { code: 'EPERM' });
  });
  const destination = String.raw`C:\journey.ad`;
  vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'chmodSync').mockReturnValue(undefined);
  vi.spyOn(fs, 'rmSync').mockReturnValue(undefined);
  const rename = vi.spyOn(fs, 'renameSync').mockReturnValue(undefined);
  onWindows(() => {
    publishScriptFileSync({ destination, contents: 'journey\n' });
    expect(stat).toHaveBeenCalledExactlyOnceWith('C:\\', { throwIfNoEntry: false });
    expect(mkdir).not.toHaveBeenCalled();
    expect(rename).toHaveBeenCalledExactlyOnceWith(expect.any(String), destination);
  });
});

test('Windows script preparation creates nested parents one level at a time', () => {
  const directory = fs.statSync(root());
  const stat = vi.spyOn(fs, 'statSync').mockReturnValue(directory);
  const mkdir = vi
    .spyOn(fs, 'mkdirSync')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('A parent is missing'), { code: 'ENOENT' });
    })
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('A directory appeared'), { code: 'EEXIST' });
    })
    .mockReturnValue(undefined);
  onWindows(() => {
    const destination = String.raw`Z:\recordings\today\journey.ad`;
    expect(prepareScriptDestination(destination).entry).toBe(destination);
  });
  expect(mkdir.mock.calls).toEqual([
    [String.raw`Z:\recordings\today`, { mode: 0o700 }],
    [String.raw`Z:\recordings`, { mode: 0o700 }],
    [String.raw`Z:\recordings\today`, { mode: 0o700 }],
  ]);
  expect(stat.mock.calls).toEqual([
    ['Z:\\', { throwIfNoEntry: false }],
    [String.raw`Z:\recordings`, { throwIfNoEntry: false }],
  ]);
});

test('Windows script preparation stops when the volume disappears after validation', () => {
  const directory = fs.statSync(root());
  const stat = vi.spyOn(fs, 'statSync').mockReturnValueOnce(directory).mockReturnValue(undefined);
  const missing = Object.assign(new Error('The volume disappeared'), { code: 'ENOENT' });
  const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
    throw missing;
  });
  onWindows(() => {
    expectUntrusted(
      () => prepareScriptDestination(String.raw`Z:\recordings\today\journey.ad`),
      'unreachable_parent',
      'Z:\\',
    );
  });
  expect(stat).toHaveBeenCalledExactlyOnceWith('Z:\\', { throwIfNoEntry: false });
  expect(mkdir.mock.calls).toEqual([
    [String.raw`Z:\recordings\today`, { mode: 0o700 }],
    [String.raw`Z:\recordings`, { mode: 0o700 }],
  ]);
});

test('Windows script preparation refuses a file that appeared in place of a parent', () => {
  const directory = fs.statSync(root());
  const file = fs.statSync(new URL(import.meta.url));
  vi.spyOn(fs, 'statSync').mockReturnValueOnce(directory).mockReturnValueOnce(file);
  const mkdir = vi
    .spyOn(fs, 'mkdirSync')
    .mockImplementationOnce(() => {
      throw Object.assign(new Error('A parent is missing'), { code: 'ENOENT' });
    })
    .mockImplementation(() => {
      throw Object.assign(new Error('A file appeared'), { code: 'EEXIST' });
    });
  onWindows(() => {
    expectUntrusted(
      () => prepareScriptDestination(String.raw`Z:\recordings\today\journey.ad`),
      'not_a_directory',
      String.raw`Z:\recordings`,
    );
  });
  expect(mkdir.mock.calls).toEqual([
    [String.raw`Z:\recordings\today`, { mode: 0o700 }],
    [String.raw`Z:\recordings`, { mode: 0o700 }],
  ]);
});

test.each(['create', 'reuse'])(
  'Windows publication can %s a parent below a traverse-only directory',
  (operation) => {
    const directory = fs.statSync(root());
    const restricted = String.raw`Z:\traverse-only`;
    const denied = Object.assign(new Error('The ancestor only permits traversal'), {
      code: 'EACCES',
    });
    const stat = vi.spyOn(fs, 'statSync').mockImplementation((name) => {
      if (name === restricted) throw denied;
      return directory;
    });
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation((name) => {
      if (name === restricted) throw denied;
      if (operation === 'reuse')
        throw Object.assign(new Error('The parent exists'), { code: 'EEXIST' });
      return undefined;
    });
    const parent = path.win32.join(restricted, 'recordings');
    const destination = path.win32.join(parent, 'journey.ad');
    onWindows(() => {
      const prepared = prepareScriptDestination(destination);
      expect(prepared.entry).toBe(destination);
      expect(confirmScriptDestination(destination, prepared).entry).toBe(destination);
    });
    expect(mkdir).toHaveBeenCalledExactlyOnceWith(parent, { mode: 0o700 });
    expect(stat).not.toHaveBeenCalledWith(restricted, expect.anything());
  },
);

test.each([
  '///journey.ad',
  '//server',
  'C:journey.ad',
  String.raw`\\?\C:\journey.ad`,
  String.raw`\\server\pipe\recorder`,
])('all Windows publication boundaries refuse the unsupported path form %s', (destination) => {
  const stat = vi.spyOn(fs, 'statSync');
  const mkdir = vi.spyOn(fs, 'mkdirSync');
  onWindows(() => {
    const prepared = {
      directory: 'C:\\',
      entry: 'C:\\journey.ad',
      name: 'journey.ad',
      identity: 'windows',
    };
    for (const attempt of [
      () => prepareScriptDestination(destination),
      () => confirmScriptDestination(destination, prepared),
    ]) {
      expect(attempt).toThrow(
        expect.objectContaining({
          details: expect.objectContaining({ exposure: 'windows_path_form' }),
        }),
      );
    }
  });
  expect(stat).not.toHaveBeenCalled();
  expect(mkdir).not.toHaveBeenCalled();
});

test("an unnamed entry is the caller's input to correct, and hints at a file name", () => {
  let failure: { code?: unknown; details?: { hint?: unknown } } | undefined;
  try {
    prepareScriptDestination('/');
  } catch (error) {
    failure = error as typeof failure;
  }
  expect(failure?.code).toBe('INVALID_ARGS');
  expect(failure?.details?.hint).toMatch(/valid file name/);
});

skipOnWindows(
  'a lone surrogate is refused before it can replace the file its replacement character names',
  () => {
    // Node writes an unpaired surrogate as U+FFFD, so a forced save would land on a different, existing file.
    const directory = root();
    const dir = directoryWith(path.join(directory, 'dir'), 0o700);
    fs.writeFileSync(path.join(dir, 'script\uFFFD.ad'), 'theirs\n');

    expectUntrusted(
      () =>
        publishScriptFileSync({
          destination: `${dir}/script\uD800.ad`,
          contents: 'x\n',
          publish: 'replace',
        }),
      'unnamed_entry',
      dir,
    );
    expect(fs.readFileSync(path.join(dir, 'script\uFFFD.ad'), 'utf8')).toBe('theirs\n');
    expect(tree(dir)).toEqual(['script\uFFFD.ad']);
  },
);
