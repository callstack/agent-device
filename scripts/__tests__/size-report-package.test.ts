import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { formatMarkdown } from '../size-report.mjs';
import { assertPublishPackageContents } from '../size-report-package.mjs';

const fixturePack = JSON.parse(
  await readFile(join(import.meta.dirname, 'fixtures', 'size-report-npm-pack.json'), 'utf8'),
);

test('publish package requires both Android helpers and excludes benchmark scripts', () => {
  assert.doesNotThrow(() => assertPublishPackageContents(fixturePack.files));
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.filter((entry) => !entry.path.startsWith('android/ime-helper/')),
      ),
    /android\/ime-helper/,
  );
  assert.throws(
    () =>
      assertPublishPackageContents(
        fixturePack.files.filter(
          (entry) => entry.path !== 'apple/snapshot-bridge/SnapshotBridgeRuntime.m',
        ),
        { requireSnapshotBridge: true },
      ),
    /SnapshotBridgeRuntime\.m/,
  );
  assert.doesNotThrow(() =>
    assertPublishPackageContents(
      fixturePack.files.filter((entry) => !entry.path.startsWith('apple/snapshot-bridge/')),
    ),
  );
  assert.throws(
    () =>
      assertPublishPackageContents([
        ...fixturePack.files,
        { path: 'scripts/ios-snapshot-benchmark/run.ts', size: 1 },
      ]),
    /benchmark or build scripts/,
  );
});

test('Markdown emphasizes total install size and startup without duplicate breakdowns', () => {
  const current = {
    bundled: { rawBytes: 300, gzipBytes: 100 },
    npmPack: {
      tarballBytes: 100,
      unpackedBytes: 300,
      entries: fixturePack.files,
    },
    cleanInstalled: { packageBytes: 300, totalBytes: 350, files: 3 },
    startup: { runs: 7, benchmarks: [{ name: 'CLI --help', medianMs: 20 }] },
  };
  const base = {
    ...current,
    npmPack: { ...current.npmPack, tarballBytes: 90, unpackedBytes: 200 },
    cleanInstalled: { packageBytes: 200, totalBytes: 900, files: 8 },
    startup: { runs: 7, benchmarks: [{ name: 'CLI --help', medianMs: 25 }] },
  };

  const markdown = formatMarkdown(current, base);

  assert.match(markdown, /<!-- agent-device-size-report -->/);
  assert.match(markdown, /\| Installed \(including dependencies\) \| 900 B \| 350 B \| -550 B \|/);
  assert.match(markdown, /\| Package \(unpacked\) \| 200 B \| 300 B \| \+100 B \|/);
  assert.match(markdown, /\| Package \(download\) \| 90 B \| 100 B \| \+10 B \|/);
  assert.match(markdown, /\| CLI --help \| 25.0 ms \| 20.0 ms \| -5.0 ms \|/);
  assert.doesNotMatch(markdown, /JS raw|JS gzip|npm bundled|components|Top.*chunks|packed files/);
  assert.match(
    formatMarkdown(current, null),
    /\| Installed \(including dependencies\) \| - \| 350 B \| - \|/,
  );
});
