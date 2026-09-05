import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { formatMarkdown } from '../size-report.mjs';
import {
  assertPublishPackageContents,
  classifyNpmPackEntry,
  summarizeNpmPackComponents,
} from '../size-report-package.mjs';

const fixturePack = JSON.parse(
  await readFile(join(import.meta.dirname, 'fixtures', 'size-report-npm-pack.json'), 'utf8'),
);

test('classifies every shipped entry into one named component', () => {
  const classified = fixturePack.files.map(classifyNpmPackEntry);

  assert.deepEqual(
    classified.map((entry) => [entry.path, entry.component]),
    [
      ['dist/src/index.js', 'js'],
      ['dist/src/index.d.ts', 'js'],
      ['dist/apple/runner/RunnerTests.swift', 'apple-runner'],
      ['dist/apple/snapshot-presentation/Package.swift', 'apple-snapshot-presentation'],
      ['apple/snapshot-bridge/SnapshotBridge.m', 'apple-snapshot-bridge'],
      ['apple/snapshot-bridge/SnapshotBridgeRuntime.m', 'apple-snapshot-bridge'],
      ['apple/snapshot-bridge/SnapshotBridgeRuntime.h', 'apple-snapshot-bridge'],
      ['apple/macos-helper/Sources/main.swift', 'macos-helper'],
      ['android/snapshot-helper/dist/helper.apk', 'android-helpers'],
      ['android/snapshot-helper/dist/helper.manifest.json', 'android-helpers'],
      ['android/ime-helper/dist/helper.apk', 'android-helpers'],
      ['android/ime-helper/dist/helper.manifest.json', 'android-helpers'],
      ['package.json', 'other'],
      ['vendor/unknown.bin', 'other'],
    ],
  );
});

test('unknown package paths fall into other', () => {
  assert.equal(
    classifyNpmPackEntry({ path: 'new/future-package-file', size: 13 }).component,
    'other',
  );
});

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

test('component bytes sum exactly to npm pack unpackedSize', () => {
  const components = summarizeNpmPackComponents(fixturePack);

  assert.equal(
    components.reduce((total, component) => total + component.unpackedBytes, 0),
    fixturePack.unpackedSize,
  );
  assert.deepEqual(
    Object.fromEntries(components.map((component) => [component.id, component.unpackedBytes])),
    {
      js: 503,
      'apple-runner': 503,
      'apple-snapshot-presentation': 113,
      'apple-snapshot-bridge': 0,
      'macos-helper': 211,
      'android-helpers': 812,
      other: 177,
    },
  );
  assert.throws(
    () => summarizeNpmPackComponents({ ...fixturePack, unpackedSize: 2318 }),
    /does not match npm pack unpackedSize/,
  );
});

test('Markdown emphasizes total install size and startup without duplicate breakdowns', () => {
  const current = {
    js: { rawBytes: 300, gzipBytes: 100 },
    bundled: { rawBytes: 300, gzipBytes: 100 },
    npmPack: {
      tarballBytes: 100,
      unpackedBytes: 300,
      components: summarizeNpmPackComponents(fixturePack),
      entries: fixturePack.files,
    },
    cleanInstalled: { packageBytes: 300, totalBytes: 350, files: 3 },
    startup: { runs: 7, benchmarks: [{ name: 'CLI --help', medianMs: 20 }] },
    chunks: [],
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
