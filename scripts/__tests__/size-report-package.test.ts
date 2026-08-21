import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';
import { formatMarkdown } from '../size-report.mjs';
import { classifyNpmPackEntry, summarizeNpmPackComponents } from '../size-report-package.mjs';

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
      ['apple/macos-helper/Sources/main.swift', 'macos-helper'],
      ['android/snapshot-helper/dist/helper.apk', 'android-helpers'],
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
      'macos-helper': 211,
      'android-helpers': 307,
      other: 177,
    },
  );
  assert.throws(
    () => summarizeNpmPackComponents({ ...fixturePack, unpackedSize: 1700 }),
    /does not match npm pack unpackedSize/,
  );
});

test('Markdown reports component diffs and changed packed files', () => {
  const current = {
    js: { rawBytes: 10, gzipBytes: 8 },
    npmPack: {
      tarballBytes: 100,
      unpackedBytes: 1701,
      components: summarizeNpmPackComponents(fixturePack),
      entries: fixturePack.files,
    },
    chunks: [],
  };
  const baseEntries = fixturePack.files.map((entry) =>
    entry.path === 'dist/src/index.js' ? { ...entry, size: 300 } : entry,
  );
  const base = {
    js: { rawBytes: 10, gzipBytes: 8 },
    npmPack: {
      tarballBytes: 100,
      unpackedBytes: 1600,
      components: summarizeNpmPackComponents({
        ...fixturePack,
        unpackedSize: 1600,
        files: baseEntries,
      }),
      entries: baseEntries,
    },
    chunks: [],
  };

  const markdown = formatMarkdown(current, base);

  assert.match(markdown, /### npm unpacked components/);
  assert.match(markdown, /\| JS \/ dist source \| 402 B \| 503 B \| \+101 B \|/);
  assert.match(markdown, /\| Other package files \| 177 B \| 177 B \| 0 B \|/);
  assert.match(markdown, /### Top changed packed files/);
  assert.match(markdown, /`dist\/src\/index\.js` \| 300 B \| 401 B \| \+101 B/);
});
