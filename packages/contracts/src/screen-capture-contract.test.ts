import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readRunnerScreenCaptureMetadata,
  type RunnerScreenCaptureMetadata,
} from './screen-capture-contract.ts';

// Cross-language golden table: the display facts a runner capture reports about its own image are
// written by the Swift encoder (`ScreenshotMetadataPayload`) and read here. Every capture in
// contracts/fixtures/screen-capture-metadata.json is asserted by this file AND by
// `UnitTests/RunnerTests+AppScreenCaptureTests.swift`, which decodes and re-encodes each one through
// the production struct, so a renamed or dropped fact turns both suites red without a simulator. The
// table names no field of its own: the two production types are the only declarations of the shape.
type ScreenCaptureMetadataTable = {
  key: string;
  captures: Array<{ name: string; metadata: RunnerScreenCaptureMetadata }>;
};

const TABLE = JSON.parse(
  fs.readFileSync(
    path.resolve(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'contracts',
      'fixtures',
      'screen-capture-metadata.json',
    ),
    'utf8',
  ),
) as ScreenCaptureMetadataTable;

const [MEASURED] = TABLE.captures;
assert(MEASURED, 'the golden table must record at least one measured capture');

/** A runner `data` payload, as the native side answers a file-path screenshot. */
function runnerPayload(metadata: unknown): Record<string, unknown> {
  return { message: 'tmp/screenshot-1.png', [TABLE.key]: metadata };
}

test('reads every measured capture the golden table records', () => {
  for (const capture of TABLE.captures) {
    // deepEqual pins the key set as well as the values, so a reader that gained or renamed a fact
    // stops matching the capture the encoder produced.
    assert.deepEqual(
      readRunnerScreenCaptureMetadata(runnerPayload(capture.metadata)),
      capture.metadata,
      capture.name,
    );
  }
});

test('refuses a payload missing any fact the golden table records', () => {
  for (const field of Object.keys(MEASURED.metadata)) {
    const partial: Record<string, number> = { ...MEASURED.metadata };
    delete partial[field];
    assert.equal(
      readRunnerScreenCaptureMetadata(runnerPayload(partial)),
      undefined,
      `missing ${field}`,
    );
  }
});

test('reports no source fact when the runner carried no metadata', () => {
  assert.equal(readRunnerScreenCaptureMetadata({ message: 'tmp/screenshot-1.png' }), undefined);
});

test.each([
  ['a non-object payload', 'not-an-object'],
  ['an array payload', [MEASURED.metadata]],
  ['the pre-panel scale probe leaking in as zero', { ...MEASURED.metadata, displayID: 0 }],
  ['a zero-scale image', { ...MEASURED.metadata, pixelsPerPoint: 0 }],
  ['a non-integer pixel box', { ...MEASURED.metadata, pixelWidth: 2852.5 }],
  ['a negative scale', { ...MEASURED.metadata, pixelsPerPoint: -3 }],
  ['a non-numeric scale', { ...MEASURED.metadata, pixelsPerPoint: '3' }],
])('refuses %s rather than guessing a capture', (_case, metadata) => {
  assert.equal(readRunnerScreenCaptureMetadata(runnerPayload(metadata)), undefined);
});
