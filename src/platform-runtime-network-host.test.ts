import assert from 'node:assert/strict';
import fs from 'node:fs';

import path from 'node:path';
import { readRecentNetworkTrafficFromText } from '@agent-device/capture-kit';
import { afterEach, test } from 'vitest';
import { readRecentAppLogLines } from './platform-runtime-network-host.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reads the exact newest line-bounded app-log suffix', async () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'app.log');
  fs.writeFileSync(pathname, 'one\ntwo\nthree\nfour\n');

  assert.deepEqual(await readRecentAppLogLines(pathname, 3), {
    path: pathname,
    exists: true,
    text: 'three\nfour\n',
    skippedLines: 2,
  });
});

test('distinguishes missing files and rejects a final-component symbolic link', async () => {
  const directory = createTemporaryDirectory();
  const outside = path.join(directory, 'outside.log');
  const linked = path.join(directory, 'app.log');
  fs.writeFileSync(outside, 'GET https://outside.example.test');

  assert.deepEqual(await readRecentAppLogLines(linked, 100), {
    path: linked,
    exists: false,
    text: '',
    skippedLines: 0,
  });

  fs.symlinkSync(outside, linked);
  await assert.rejects(readRecentAppLogLines(linked, 100), /regular file/);
});

test('preserves absolute source line numbers after selecting a bounded suffix', async () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'app.log');
  const text = [
    ...Array.from({ length: 5000 }, (_, index) => `filler ${index + 1}`),
    'GET https://example.test status=200',
  ].join('\n');
  fs.writeFileSync(pathname, `${text}\n`);

  const recent = await readRecentAppLogLines(pathname, 4000);
  const { dump } = readRecentNetworkTrafficFromText(recent.text, {
    path: recent.path,
    exists: recent.exists,
    backend: 'android',
    maxEntries: 25,
    include: 'summary',
    maxPayloadChars: 2048,
    maxScanLines: 4000,
    lineNumberOffset: recent.skippedLines,
  });

  assert.equal(dump.entries[0]?.line, 5001);
});

test('selects the same suffix across read blocks as a whole-file split', async () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'app.log');
  // About 1 MiB in many 64 KiB blocks, with multi-byte characters that can straddle a block edge.
  const text = Array.from(
    { length: 30_000 },
    (_, index) => `line ${index} ✓ ${'y'.repeat(20)}`,
  ).join('\n');
  fs.writeFileSync(pathname, text);
  const lines = text.split('\n');

  for (const maxScanLines of [1, 4321, 20_000]) {
    const skippedLines = lines.length - maxScanLines;
    assert.deepEqual(await readRecentAppLogLines(pathname, maxScanLines), {
      path: pathname,
      exists: true,
      text: lines.slice(skippedLines).join('\n'),
      skippedLines,
    });
  }
});

function createTemporaryDirectory(): string {
  const directory = mkdtempForTestSync('agent-device-network-host-');
  temporaryDirectories.push(directory);
  return directory;
}
