import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from '@agent-device/capture-kit/png';
import { buildCorpus, cropBoxOf, CROP_SCENARIOS } from './corpus.ts';

const SCENARIO_BY_NAME = new Map(CROP_SCENARIOS.map((scenario) => [scenario.name, scenario]));
const CAPTURE = {
  name: 'phone',
  label: 'phone',
  width: 1200,
  height: 2400,
  bytes: Buffer.alloc(0),
};
const SMALL = [{ name: 'tiny', label: 'tiny', width: 24, height: 40 }];

test('a card crop keeps the framed fraction of the capture', () => {
  const box = cropBoxOf(CAPTURE, SCENARIO_BY_NAME.get('card')!);

  assert.deepEqual(box, { x: 96, y: 600, width: 960, height: 480 });
});

test('a full-bleed header is clamped to the image, never one pixel past it', () => {
  const box = cropBoxOf(CAPTURE, SCENARIO_BY_NAME.get('header')!);

  assert.equal(box.x, 0);
  assert.equal(box.width, CAPTURE.width);
  assert.equal(box.y + box.height, 288);
});

test('the same generated capture comes out byte for byte every run', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'png-crop-corpus-'));
  try {
    const first = buildCorpus(path.join(directory, 'first'), SMALL);
    const second = buildCorpus(path.join(directory, 'second'), SMALL);

    assert.equal(first.length, 2);
    assert.deepEqual(
      first.map((capture) => capture.bytes),
      second.map((capture) => capture.bytes),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('interface and photo captures differ, and both decode at their declared size', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'png-crop-corpus-'));
  try {
    const [interfaceCapture, photoCapture] = buildCorpus(directory, SMALL);

    const decoded = [interfaceCapture, photoCapture].map((capture) =>
      PNG.sync.read(capture!.bytes),
    );
    assert.deepEqual(
      decoded.map((png) => [png.width, png.height]),
      [
        [24, 40],
        [24, 40],
      ],
    );
    assert.notDeepEqual(decoded[0]!.data, decoded[1]!.data);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
