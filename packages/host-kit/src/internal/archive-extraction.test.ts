import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { extractArchiveSafely, type SupportedArchiveType } from './archive-extraction.ts';
import {
  writeTarFixture,
  writeZipFixture,
  type TarFixtureEntry,
  type ZipFixtureEntry,
} from './archive-extraction.fixtures.ts';
import { mkdtempForTest } from './tmp-dir.fixtures.ts';

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFIFO = 0o010000;

type ArchiveFixture =
  | { type: 'zip'; entries: readonly ZipFixtureEntry[] }
  | { type: 'tar'; entries: readonly TarFixtureEntry[] };

async function extractFixture(fixture: ArchiveFixture): Promise<{
  root: string;
  outputRoot: string;
  error: unknown;
}> {
  const root = await mkdtempForTest('agent-device-archive-extraction-');
  const archivePath = path.join(root, `fixture.${fixture.type}`);
  if (fixture.type === 'zip') await writeZipFixture(archivePath, fixture.entries);
  else await writeTarFixture(archivePath, fixture.entries);
  const outputRoot = path.join(root, 'extracted');
  const type: SupportedArchiveType = fixture.type;
  const error = await extractArchiveSafely({ archivePath, outputRoot, type }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { root, outputRoot, error };
}

function reason(error: unknown): unknown {
  return error instanceof AppError ? error.details?.reason : undefined;
}

async function pathExists(target: string): Promise<boolean> {
  return await fs.lstat(target).then(
    () => true,
    () => false,
  );
}

const REFUSED_ENTRIES: ReadonlyArray<{
  label: string;
  fixture: ArchiveFixture;
  reason?: string;
}> = [
  {
    label: 'zip symlink',
    fixture: { type: 'zip', entries: [{ name: 'App.app/link', mode: S_IFLNK | 0o777, data: '/' }] },
    reason: 'ARCHIVE_UNSAFE_ENTRY',
  },
  {
    label: 'zip FIFO',
    fixture: { type: 'zip', entries: [{ name: 'App.app/fifo', mode: S_IFIFO | 0o644 }] },
    reason: 'ARCHIVE_UNSAFE_ENTRY',
  },
  {
    label: 'zip parent-escaping path',
    fixture: {
      type: 'zip',
      entries: [{ name: 'App.app/../../escaped', mode: S_IFREG | 0o644, data: 'x' }],
    },
  },
  {
    label: 'zip absolute path',
    fixture: { type: 'zip', entries: [{ name: '/escaped', mode: S_IFREG | 0o644, data: 'x' }] },
  },
  {
    label: 'tar symlink',
    fixture: {
      type: 'tar',
      entries: [{ header: { name: 'App.app/link', type: 'symlink', linkname: '/' } }],
    },
    reason: 'ARCHIVE_UNSAFE_ENTRY',
  },
  {
    label: 'tar hard link',
    fixture: {
      type: 'tar',
      entries: [{ header: { name: 'App.app/link', type: 'link', linkname: '/etc/hosts' } }],
    },
    reason: 'ARCHIVE_UNSAFE_ENTRY',
  },
  {
    label: 'tar character device',
    fixture: {
      type: 'tar',
      entries: [{ header: { name: 'App.app/dev', type: 'character-device' } }],
    },
    reason: 'ARCHIVE_UNSAFE_ENTRY',
  },
  {
    label: 'tar FIFO',
    fixture: { type: 'tar', entries: [{ header: { name: 'App.app/fifo', type: 'fifo' } }] },
    reason: 'ARCHIVE_UNSAFE_ENTRY',
  },
  {
    label: 'tar parent-escaping path',
    fixture: { type: 'tar', entries: [{ header: { name: '../escaped' }, data: 'x' }] },
    reason: 'ARCHIVE_UNSAFE_PATH',
  },
  {
    label: 'tar PAX path override',
    fixture: {
      type: 'tar',
      entries: [{ header: { name: 'App.app/safe' }, pax: { path: '../../escaped' }, data: 'x' }],
    },
    reason: 'ARCHIVE_UNSAFE_PATH',
  },
  {
    label: 'tar PAX linkpath symlink',
    fixture: {
      type: 'tar',
      entries: [
        {
          header: { name: 'App.app/link', type: 'symlink', linkname: 'x' },
          pax: { linkpath: '/' },
        },
      ],
    },
    reason: 'ARCHIVE_UNSAFE_ENTRY',
  },
];

test.each(REFUSED_ENTRIES)(
  '$label is refused and nothing is written',
  async ({ fixture, reason: expectedReason }) => {
    const { root, outputRoot, error } = await extractFixture(fixture);

    assert.ok(error instanceof Error, 'extraction must be refused');
    if (expectedReason) assert.equal(reason(error), expectedReason);
    assert.equal(await pathExists(outputRoot), false);
    assert.deepEqual((await fs.readdir(root)).sort(), [`fixture.${fixture.type}`]);
    assert.equal(await pathExists(path.join(path.dirname(root), 'escaped')), false);
    assert.equal(await pathExists('/escaped'), false);
  },
);

test.each<ArchiveFixture>([
  {
    type: 'zip',
    entries: [
      { name: 'App.app/a', mode: S_IFREG | 0o644, data: 'first' },
      { name: 'App.app/a', mode: S_IFREG | 0o644, data: 'second' },
    ],
  },
  {
    type: 'tar',
    entries: [
      { header: { name: 'App.app/a' }, data: 'first' },
      { header: { name: 'App.app/a' }, data: 'second' },
    ],
  },
])('a duplicate $type entry is refused instead of overwriting the first', async (fixture) => {
  const { outputRoot, error } = await extractFixture(fixture);

  assert.equal((error as NodeJS.ErrnoException).code, 'EEXIST');
  assert.equal(await pathExists(outputRoot), false);
});

test('case-colliding zip entries never overwrite each other', async () => {
  const { outputRoot, error } = await extractFixture({
    type: 'zip',
    entries: [
      { name: 'App.app/Name', mode: S_IFREG | 0o644, data: 'upper' },
      { name: 'App.app/name', mode: S_IFREG | 0o644, data: 'lower' },
    ],
  });

  if (error === undefined) {
    assert.equal(await fs.readFile(path.join(outputRoot, 'App.app/Name'), 'utf8'), 'upper');
    assert.equal(await fs.readFile(path.join(outputRoot, 'App.app/name'), 'utf8'), 'lower');
  } else {
    assert.equal((error as NodeJS.ErrnoException).code, 'EEXIST');
    assert.equal(await pathExists(outputRoot), false);
  }
});

test.each<ArchiveFixture>([
  { type: 'zip', entries: [{ name: 'App.app/App', mode: S_IFREG | 0o7755, data: 'bin' }] },
  { type: 'tar', entries: [{ header: { name: 'App.app/App', mode: 0o7755 }, data: 'bin' }] },
])('$type extraction strips set-id and sticky bits but keeps execute bits', async (fixture) => {
  const { outputRoot, error } = await extractFixture(fixture);

  assert.equal(error, undefined);
  const mode = (await fs.stat(path.join(outputRoot, 'App.app/App'))).mode;
  assert.equal(mode & 0o7000, 0);
  assert.equal(mode & 0o100, 0o100);
});

const GROUP_WRITABLE_DIRECTORY = {
  zip: { name: 'App.app/d/', mode: S_IFDIR | 0o770 },
  tar: { header: { name: 'App.app/d', type: 'directory', mode: 0o770 } },
} as const;
const DIRECTORY_CHILD = {
  zip: { name: 'App.app/d/child', mode: S_IFREG | 0o644, data: 'x' },
  tar: { header: { name: 'App.app/d/child' }, data: 'x' },
} as const;

test.each<ArchiveFixture & { order: 'before' | 'after' }>([
  { type: 'zip', order: 'before', entries: [GROUP_WRITABLE_DIRECTORY.zip, DIRECTORY_CHILD.zip] },
  { type: 'zip', order: 'after', entries: [DIRECTORY_CHILD.zip, GROUP_WRITABLE_DIRECTORY.zip] },
  { type: 'tar', order: 'before', entries: [GROUP_WRITABLE_DIRECTORY.tar, DIRECTORY_CHILD.tar] },
  { type: 'tar', order: 'after', entries: [DIRECTORY_CHILD.tar, GROUP_WRITABLE_DIRECTORY.tar] },
])(
  'a $type directory declared $order its children gets its declared mode under the umask',
  async (fixture) => {
    const { outputRoot, error } = await extractFixture(fixture);

    assert.equal(error, undefined);
    assert.equal(
      (await fs.stat(path.join(outputRoot, 'App.app/d'))).mode & 0o777,
      0o770 & ~process.umask(),
    );
  },
);

test.each<ArchiveFixture>([
  {
    type: 'zip',
    entries: [
      { name: 'App.app/private/', mode: S_IFDIR },
      { name: 'App.app/private/secret', mode: S_IFREG, data: 'x' },
    ],
  },
  {
    type: 'tar',
    entries: [
      { header: { name: 'App.app/private', type: 'directory', mode: 0 } },
      {
        header: { name: 'App.app/private/secret', mode: 0 },
        pax: { path: 'App.app/private/secret' },
        data: 'x',
      },
    ],
  },
])('an explicit $type mode of zero extracts with owner access only', async (fixture) => {
  const { outputRoot, error } = await extractFixture(fixture);

  assert.equal(error, undefined);
  assert.equal((await fs.stat(path.join(outputRoot, 'App.app/private'))).mode & 0o777, 0o700);
  assert.equal(
    (await fs.stat(path.join(outputRoot, 'App.app/private/secret'))).mode & 0o777,
    0o600,
  );
});

test('a zip entry without Unix attributes gets the default mode', async () => {
  const { outputRoot, error } = await extractFixture({
    type: 'zip',
    entries: [
      { name: 'App.app/dir/', mode: 0 },
      { name: 'App.app/dir/file', mode: 0, data: 'x' },
    ],
  });

  assert.equal(error, undefined);
  const directory = (await fs.stat(path.join(outputRoot, 'App.app/dir'))).mode & 0o777;
  const file = (await fs.stat(path.join(outputRoot, 'App.app/dir/file'))).mode & 0o777;
  assert.equal(directory, 0o755 & ~process.umask());
  assert.equal(file, 0o644 & ~process.umask());
});

test.each<ArchiveFixture>([
  {
    type: 'zip',
    entries: [
      { name: 'App.app/x', mode: S_IFREG | 0o644, data: 'file' },
      { name: 'App.app/x/', mode: S_IFDIR | 0o755 },
    ],
  },
  {
    type: 'tar',
    entries: [
      { header: { name: 'App.app/x' }, data: 'file' },
      { header: { name: 'App.app/x', type: 'directory' } },
    ],
  },
])('a $type directory colliding with an earlier file is refused', async (fixture) => {
  const { outputRoot, error } = await extractFixture(fixture);

  assert.equal((error as NodeJS.ErrnoException).code, 'EEXIST');
  assert.equal(await pathExists(outputRoot), false);
});

const UNREADABLE_DIRECTORY = {
  zip: { name: 'App.app/locked/', mode: S_IFDIR | 0o300 },
  tar: { header: { name: 'App.app/locked', type: 'directory', mode: 0o300 } },
} as const;

test.each<ArchiveFixture>([
  {
    type: 'zip',
    entries: [
      UNREADABLE_DIRECTORY.zip,
      { name: 'App.app/locked/payload', mode: S_IFREG | 0o644, data: 'payload' },
    ],
  },
  {
    type: 'tar',
    entries: [
      UNREADABLE_DIRECTORY.tar,
      { header: { name: 'App.app/locked/payload' }, data: 'payload' },
    ],
  },
])('a $type directory declared without owner access stays removable', async (fixture) => {
  const { outputRoot, error } = await extractFixture(fixture);

  assert.equal(error, undefined);
  for (const directory of ['App.app', 'App.app/locked']) {
    const mode = (await fs.stat(path.join(outputRoot, directory))).mode;
    assert.equal(mode & 0o700, 0o700, `${directory} must stay owner-accessible`);
  }
  await fs.rm(outputRoot, { recursive: true });
  assert.equal(await pathExists(outputRoot), false);
});

test.each<ArchiveFixture>([
  {
    type: 'zip',
    entries: [
      UNREADABLE_DIRECTORY.zip,
      { name: 'App.app/locked/payload', mode: S_IFREG | 0o644, data: 'payload' },
      { name: 'App.app/locked/payload', mode: S_IFREG | 0o644, data: 'payload' },
    ],
  },
  {
    type: 'tar',
    entries: [
      UNREADABLE_DIRECTORY.tar,
      { header: { name: 'App.app/locked/payload' }, data: 'payload' },
      { header: { name: 'App.app/locked/payload' }, data: 'payload' },
    ],
  },
])(
  'a failed $type extraction under an unreadable directory reports its own error and leaves nothing',
  async (fixture) => {
    const { outputRoot, error } = await extractFixture(fixture);

    assert.equal((error as NodeJS.ErrnoException).code, 'EEXIST');
    assert.equal(await pathExists(outputRoot), false);
  },
);
