import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { eagerClosureOf, eagerlyEvaluatedModules, REPO_ROOT } from '@agent-device/test-kit';
import { DAEMON_SOURCE_ROOT } from '../../scripts/layering/tracked-sources.ts';

/**
 * The ZIP and TAR readers (`yauzl`, `tar-stream`) are the heaviest code the install and upload
 * paths carry: 63.7 kB of minified bundle sat in the daemon's boot closure because every module
 * that could extract an archive also evaluated both codecs (#4980). `extractArchiveSafely` loads
 * the reader for the format it is about to read, so only a call that really extracts pays for it.
 *
 * What stays eager is deliberate and is what the ingress limits are made of: `ArchiveBudget`,
 * `MAX_ARTIFACT_COMPRESSED_BYTES`, `archiveTypeFromPath` and `createByteLimitStream` reject an
 * oversized upload before a reader is opened, so the upload handler must not await a load to
 * enforce them.
 *
 * This pins that seam across the owners that reached the codecs statically before: restoring
 * either `await import` in `archive-extraction.ts` to a static import fails here.
 */

const ARCHIVE_READERS = [
  /host-kit[/\\]src[/\\]internal[/\\]archive-extraction-zip\.ts$/,
  /host-kit[/\\]src[/\\]internal[/\\]archive-extraction-tar\.ts$/,
];
const ARCHIVE_CODECS = new Set(['yauzl', 'tar-stream']);

/**
 * Entry points whose eager closure reached the codecs statically before this change: the daemon's
 * boot surface (loaded through `await import` while the daemon starts, so its eager closure is
 * boot code), the upload owners, and the install-side extraction owners. `src/cli.ts` and
 * `src/daemon.ts` are deliberately absent: both reach extraction only over a dynamic edge, so a
 * row for either could never fail this guard. Rows are objects with an `id` so each parameterised
 * case is titled with its owner: `$id` resolves only against object rows, and a plain-string row
 * titles every case identically.
 */
const OWNERS_THAT_MUST_NOT_LOAD_A_READER = [
  {
    id: 'daemon boot surface',
    file: `${DAEMON_SOURCE_ROOT}server/http/server-startup.ts`,
  },
  { id: 'daemon upload', file: `${DAEMON_SOURCE_ROOT}server/upload.ts` },
  { id: 'daemon resumable upload', file: `${DAEMON_SOURCE_ROOT}server/resumable-upload.ts` },
  { id: 'host-kit archive surface', file: 'packages/host-kit/src/archive.ts' },
  { id: 'provision-kit install source', file: 'packages/provision-kit/src/install-source.ts' },
  {
    id: 'apple install artifact',
    file: 'packages/platform-apple/src/core/install-artifact.ts',
  },
];

function readerModules(entryFile: string): string[] {
  return eagerClosureOf(path.join(REPO_ROOT, entryFile)).filter((file) =>
    ARCHIVE_READERS.some((pattern) => pattern.test(file)),
  );
}

function codecSpecifiers(entryFile: string): string[] {
  return eagerClosureOf(path.join(REPO_ROOT, entryFile)).flatMap((file) =>
    eagerlyEvaluatedModules(file, fs.readFileSync(file, 'utf8'))
      .filter((specifier) => ARCHIVE_CODECS.has(specifier))
      .map((specifier) => `${path.relative(REPO_ROOT, file)} -> ${specifier}`),
  );
}

test.for(OWNERS_THAT_MUST_NOT_LOAD_A_READER)(
  '$id never evaluates an archive reader module',
  ({ file }: { id: string; file: string }) => {
    expect(
      readerModules(file).map((f) => path.relative(REPO_ROOT, f)),
      'Load the reader for the format being extracted with `await import` instead: every module ' +
        'that can extract an archive is reachable from daemon and CLI startup, so a static reader ' +
        'import puts both codecs on a path that mostly never extracts.',
    ).toEqual([]);
  },
);

test.for(OWNERS_THAT_MUST_NOT_LOAD_A_READER)(
  '$id never evaluates yauzl or tar-stream',
  ({ file }: { id: string; file: string }) => {
    expect(
      codecSpecifiers(file),
      'The archive codecs reach this entry through a static import chain. Keep them behind the ' +
        'format dispatch in `archive-extraction.ts`.',
    ).toEqual([]);
  },
);

test('the archive seam stays reachable and the reader side really carries the codecs', () => {
  // Non-vacuity for both guards above: a resolver that matched nothing, or a reader module that
  // stopped importing its codec, would leave the lists empty while the pins stayed green.
  const archiveSurface = eagerClosureOf(path.join(REPO_ROOT, 'packages/host-kit/src/archive.ts'));
  expect(archiveSurface).toContain(
    path.join(REPO_ROOT, 'packages/host-kit/src/internal/archive-extraction.ts'),
  );
  for (const { reader, codec } of [
    { reader: 'archive-extraction-zip.ts', codec: 'yauzl' },
    { reader: 'archive-extraction-tar.ts', codec: 'tar-stream' },
  ]) {
    const readerFile = path.join(REPO_ROOT, 'packages/host-kit/src/internal', reader);
    expect(fs.existsSync(readerFile), reader).toBe(true);
    expect(eagerlyEvaluatedModules(readerFile, fs.readFileSync(readerFile, 'utf8'))).toEqual(
      expect.arrayContaining([codec]),
    );
  }
});
