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
} from './atomic-file-host.fixtures.ts';
import {
  confirmScriptDestination,
  isAtomicPublishTemporaryPath,
  prepareScriptDestination,
  publishScriptFileSync,
  scriptEntryName,
  unnamedEntryFailure,
  withAtomicPublishTempPathSync,
} from './atomic-file.ts';
import { resolveScriptDestination } from './path-resolution.ts';

const skipOnWindows = process.platform === 'win32' ? test.skip : test;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every entry under `directory`, so a refusal can show it created nothing anywhere below it. */
function tree(directory: string): string[] {
  return fs.readdirSync(directory, { recursive: true }).map(String).sort();
}

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

test('a Windows confirmation refuses a different directory under the one identity Windows answers', () => {
  // No walk runs on Windows, so every directory answers the identity `windows`; only the path tells two apart.
  const directory = root();
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const prepared = prepareScriptDestination(path.join(directory, 'judged', 'journey.ad'));

    expectUntrustedReplaced(
      () => confirmScriptDestination(path.join(directory, 'other', 'journey.ad'), prepared),
      path.join(directory, 'other'),
    );
  } finally {
    Object.defineProperty(process, 'platform', original!);
  }
});

test.each([
  { spelled: '\\\\server\\share\\', name: undefined },
  { spelled: '\\\\server\\share', name: undefined },
  { spelled: '\\\\?\\UNC\\server\\share\\', name: undefined },
  { spelled: '\\\\?\\UNC\\server\\share', name: undefined },
  { spelled: '\\\\.\\UNC\\server\\share', name: undefined },
  { spelled: '\\\\?\\UNC\\server', name: undefined },
  { spelled: '\\\\?\\C:\\', name: undefined },
  { spelled: 'C:\\', name: undefined },
  { spelled: 'C:', name: undefined },
  { spelled: 'C:\\dir\\..', name: undefined },
  { spelled: '\\\\server\\share\\journey.ad', name: 'journey.ad' },
  { spelled: '\\\\?\\UNC\\server\\share\\journey.ad', name: 'journey.ad' },
  { spelled: 'C:\\dir\\journey.ad\\', name: 'journey.ad' },
  { spelled: '//?//UNC/server/share', name: undefined },
  { spelled: '\\\\?\\\\UNC\\server\\share', name: undefined },
  { spelled: '//?/UNC//server//share/', name: undefined },
  { spelled: '\\\\.\\pipe\\recorder', name: undefined },
  { spelled: '//./pipe/recorder', name: undefined },
  { spelled: '\\\\?\\GLOBALROOT\\Device\\journey.ad', name: undefined },
  { spelled: 'CON', name: undefined },
  { spelled: 'C:\\dir\\con.txt', name: undefined },
  { spelled: 'C:\\dir\\Lpt9.ad', name: undefined },
  { spelled: 'C:\\dir\\nul .ad', name: undefined },
  { spelled: 'C:\\dir\\COM1', name: undefined },
  { spelled: 'C:\\missing\\log.ad:private', name: undefined },
  { spelled: 'C:\\dir:x\\journey.ad', name: undefined },
  { spelled: '\\\\server\\share\\a:b', name: undefined },
  { spelled: 'C:\\dir\\console.ad', name: 'console.ad' },
  { spelled: 'C:\\dir\\COM10.ad', name: 'COM10.ad' },
  { spelled: 'C:journey.ad', name: 'journey.ad' },
  { spelled: '//server//share//journey.ad', name: 'journey.ad' },
  { spelled: 'C:\\new\\bad?.ad', name: undefined },
  { spelled: 'C:\\new\\a<b.ad', name: undefined },
  { spelled: 'C:\\new\\a>b.ad', name: undefined },
  { spelled: 'C:\\new\\a"b.ad', name: undefined },
  { spelled: 'C:\\new\\a|b.ad', name: undefined },
  { spelled: 'C:\\new\\a*b.ad', name: undefined },
  { spelled: 'C:\\new\\a\u0001b.ad', name: undefined },
  { spelled: 'C:\\new\\a\u001fb.ad', name: undefined },
  { spelled: 'C:\\new\\trailing.', name: undefined },
  { spelled: 'C:\\new\\trailing ', name: undefined },
  { spelled: 'C:\\new\\COM¹.ad', name: undefined },
  { spelled: 'C:\\new\\com²', name: undefined },
  { spelled: 'C:\\new\\LPT³.log', name: undefined },
  { spelled: '\\\\?\\PIPE\\recorder', name: undefined },
  { spelled: '\\\\?\\Volume{0}\\journey.ad', name: undefined },
  { spelled: '\\\\?\\C:\\dir\\journey.ad', name: 'journey.ad' },
  { spelled: 'C:\\new\\COM⁴.ad', name: 'COM⁴.ad' },
  { spelled: 'C:\\dir\\COM¹\u00A0.ad', name: 'COM¹\u00A0.ad' },
  { spelled: 'C:\\dir\\COM¹ .ad', name: undefined },
  { spelled: 'C:\\new\\a b.c.ad', name: 'a b.c.ad' },
  { spelled: `C:\\dir\\${'a'.repeat(256)}`, name: undefined },
  { spelled: `C:\\dir\\${'é'.repeat(255)}`, name: 'é'.repeat(255) },
])('Windows rules name $name for $spelled', ({ spelled, name }) => {
  expect(scriptEntryName(spelled, path.win32)).toBe(name);
});

test.each([
  { spelled: '/', name: undefined },
  { spelled: '~', name: undefined },
  { spelled: '~/', name: undefined },
  { spelled: '~/.', name: undefined },
  { spelled: './missing/.', name: undefined },
  { spelled: 'dir/~', name: '~' },
  { spelled: '~/journey.ad', name: 'journey.ad' },
  { spelled: 'journey.ad/', name: 'journey.ad' },
  { spelled: 'script\uD800.ad', name: undefined },
  { spelled: 'dir\uDC00/journey.ad', name: undefined },
  { spelled: 'script😀.ad', name: 'script😀.ad' },
])('POSIX rules name $name for $spelled', ({ spelled, name }) => {
  expect(scriptEntryName(spelled, path.posix)).toBe(name);
});

skipOnWindows.each(['./missing/.', 'missing/..', '~/', '~'])(
  'expanding %s refuses it before the expansion folds its last segment away',
  (spelled) => {
    const directory = root();

    expectUntrusted(
      () => resolveScriptDestination(spelled, { cwd: directory, env: { HOME: directory } }),
      'unnamed_entry',
      path.dirname(spelled),
    );
    expect(tree(directory)).toEqual([]);
  },
);

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

test('a temp sibling belongs to its own destination even when another name shares its first 64 bytes', () => {
  const shared = 'a'.repeat(64);
  const first = path.join('/recordings', `${shared}-first.ad`);
  const second = path.join('/recordings', `${shared}-second.ad`);
  const sibling = withAtomicPublishTempPathSync(first, (temporaryPath) => temporaryPath);

  expect(isAtomicPublishTemporaryPath(sibling, first)).toBe(true);
  expect(isAtomicPublishTemporaryPath(sibling, second)).toBe(false);
  expect(Buffer.byteLength(path.basename(sibling))).toBeLessThan(128);
});

test.each([
  { spelled: 'C:\\di:r\\journey.ad', blames: 'path' },
  { spelled: 'C:\\dir\\a:b.ad', blames: 'name' },
])(
  'a Windows colon in the $blames is refused with a hint about the $blames',
  ({ spelled, blames }) => {
    const failure = unnamedEntryFailure(spelled, path.win32);

    expect(failure.code).toBe('INVALID_ARGS');
    expect(failure.details).toMatchObject({
      exposure: 'unnamed_entry',
      ancestor: path.win32.dirname(spelled),
    });
    if (blames === 'path') expect(failure.details?.hint).toMatch(/directory names/);
    else expect(failure.details?.hint).toMatch(/valid file name/);
  },
);

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

test('a temp stem counts bytes, keeping 16 two-byte characters of a long name', () => {
  const sibling = withAtomicPublishTempPathSync(
    path.join('/recordings', `${'é'.repeat(32)}.ad`),
    (temporaryPath) => temporaryPath,
  );

  expect(path.basename(sibling).split('.')[1]).toBe('é'.repeat(16));
});
