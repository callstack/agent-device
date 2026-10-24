import assert from 'node:assert/strict';
import fs from 'node:fs';

import path from 'node:path';
import { readRecentNetworkTrafficFromText } from '@agent-device/capture-kit';
import { afterEach, test } from 'vitest';
import {
  NETWORK_CAPTURE_FILE_CAP_BYTES,
  readRecentAppLogLines,
  readRecentNetworkCaptureLines,
} from './platform-runtime-network-host.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('reads the exact newest line-bounded app-log suffix', () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'app.log');
  fs.writeFileSync(pathname, 'one\ntwo\nthree\nfour\n');

  assert.deepEqual(readRecentAppLogLines(pathname, 3), {
    path: pathname,
    exists: true,
    text: 'three\nfour\n',
    skippedLines: 2,
  });
});

test('distinguishes missing files and rejects a final-component symbolic link', () => {
  const directory = createTemporaryDirectory();
  const outside = path.join(directory, 'outside.log');
  const linked = path.join(directory, 'app.log');
  fs.writeFileSync(outside, 'GET https://outside.example.test');

  assert.deepEqual(readRecentAppLogLines(linked, 100), {
    path: linked,
    exists: false,
    text: '',
    skippedLines: 0,
  });

  fs.symlinkSync(outside, linked);
  assert.throws(() => readRecentAppLogLines(linked, 100), /regular file/);
});

test('preserves absolute source line numbers after selecting a bounded suffix', () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'app.log');
  const text = [
    ...Array.from({ length: 5000 }, (_, index) => `filler ${index + 1}`),
    'GET https://example.test status=200',
  ].join('\n');
  fs.writeFileSync(pathname, `${text}\n`);

  const recent = readRecentAppLogLines(pathname, 4000);
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

test('bounds one capture-probe read in bytes and keeps the newest window', () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'network.jsonl');
  const old = `${'x'.repeat(64)}\n`.repeat(200);
  const fresh = `${JSON.stringify({ url: 'https://api.example.test/v1/newest', status: 200 })}\n`;
  fs.writeFileSync(pathname, `${old}${fresh}`);

  const recent = readRecentNetworkCaptureLines({
    pathname,
    maxScanLines: 4000,
    redactionPatterns: [],
  });

  assert.equal(recent.exists, true);
  assert.ok(recent.text.endsWith(fresh));
});

test('applies the operator redaction patterns to the capture-probe window', () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'network.jsonl');
  fs.writeFileSync(
    pathname,
    `${JSON.stringify({ url: 'https://api.example.test/v1/a?token=secret', status: 200 })}\n`,
  );

  const recent = readRecentNetworkCaptureLines({
    pathname,
    maxScanLines: 100,
    redactionPatterns: [/secret/g],
  });

  assert.match(recent.text, /\[REDACTED\]/);
  assert.doesNotMatch(recent.text, /secret/);
});

test('a byte-window read never hands the parser a partial first line', () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'network.jsonl');
  // Push the file past the 2 MB byte budget so the read window starts mid-file. The filler lines
  // are exactly 50 characters, so a fragment surviving the window cut would be a short line.
  const filler = `${'p'.repeat(50)}\n`;
  const whole = `${JSON.stringify({ url: 'https://api.example.test/whole', status: 201 })}\n`;
  fs.writeFileSync(
    pathname,
    `${filler.repeat(Math.ceil((2 * 1024 * 1024) / filler.length) + 7)}${whole}`,
  );

  const recent = readRecentNetworkCaptureLines({
    pathname,
    maxScanLines: 60_000,
    redactionPatterns: [],
  });

  assert.equal(recent.exists, true);
  const lines = recent.text.split('\n').filter((line) => line.length > 0);
  assert.ok(lines.length > 1, 'the window kept a real frame');
  for (const line of lines) {
    assert.ok(
      line.length === 50 || line.startsWith('{'),
      `partial line reached the parser: ${line.slice(0, 40)}`,
    );
  }
  assert.ok(recent.text.endsWith(whole));
  assert.ok(recent.skippedLines >= 1, 'the dropped fragment counts as a skipped line');
});

function createTemporaryDirectory(): string {
  const directory = mkdtempForTestSync('agent-device-network-host-');
  temporaryDirectories.push(directory);
  return directory;
}

test('a probe file at its 32 MB cap reports atSizeCap so the dump can say the window is frozen', () => {
  const directory = createTemporaryDirectory();
  const pathname = path.join(directory, 'network.jsonl');
  const line = `${JSON.stringify({ url: 'https://api.example.test/v1/newest', status: 200 })}\n`;
  // The cap check reads the file size alone, so a sparse hole stands in for the 32 MB a long
  // session wrote, with a real newline-bounded frame kept at the tail the reader must preserve.
  const filler = `${'p'.repeat(50)}\n`.repeat(20_000);
  fs.writeFileSync(pathname, line);
  fs.truncateSync(pathname, NETWORK_CAPTURE_FILE_CAP_BYTES - filler.length - line.length);
  assert.equal(
    readRecentNetworkCaptureLines({ pathname, maxScanLines: 100, redactionPatterns: [] }).atSizeCap,
    false,
  );
  fs.appendFileSync(pathname, `${filler}${line}`);
  const capped = readRecentNetworkCaptureLines({
    pathname,
    maxScanLines: 60_000,
    redactionPatterns: [],
  });
  assert.equal(capped.atSizeCap, true);
  assert.ok(capped.text.endsWith(line), 'the newest window is still readable at the cap');
});
