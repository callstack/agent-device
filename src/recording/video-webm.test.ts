import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { likelyPlayableWebmContainer } from '../__tests__/test-utils/video-fixtures.ts';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';
import { hasPlayableWebmStructure } from './video-webm.ts';

const directory = mkdtempForTestSync('agent-device-video-webm-structure-');
const playableWebm = likelyPlayableWebmContainer();

test('recognizes a real WebM video track and complete media block', () => {
  expect(hasPlayableWebmStructure(writeFixture('capture.webm', playableWebm))).toBe(true);
});

test('accepts a finalized WebM whose Segment retains its legal unknown size', () => {
  expect(
    hasPlayableWebmStructure(
      writeFixture('unknown-segment-size.webm', withUnknownSegmentSize(playableWebm)),
    ),
  ).toBe(true);
});

test.each([
  ['an extension without a container', Buffer.from('webm')],
  ['an empty Segment', emptyWebmContainer()],
  ['a media block truncated before its declared end', truncateInsideMediaBlock(playableWebm)],
  [
    'DocType bytes nested inside an unrelated header element',
    webmWithNestedFakeDocumentType(playableWebm),
  ],
])('rejects %s', (name, bytes) => {
  expect(hasPlayableWebmStructure(writeFixture(`${name}.webm`, bytes))).toBe(false);
});

function writeFixture(name: string, bytes: Buffer): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

function emptyWebmContainer(): Buffer {
  return Buffer.from(
    '1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806780',
    'hex',
  );
}

function withUnknownSegmentSize(webm: Buffer): Buffer {
  const result = Buffer.from(webm);
  Buffer.from('01ffffffffffffff', 'hex').copy(result, 40);
  return result;
}

function truncateInsideMediaBlock(webm: Buffer): Buffer {
  const block = webm.indexOf(Buffer.from([0xa3, 0xa3]));
  expect(block).toBeGreaterThan(0);
  return webm.subarray(0, block + 6);
}

function webmWithNestedFakeDocumentType(webm: Buffer): Buffer {
  const segment = webm.subarray(36);
  const headerWithDocumentTypeInsideVoid = Buffer.from(
    '1a45dfa3a14286810142f7810142f2810442f38108ec874282847765626d4287810442858102',
    'hex',
  );
  return Buffer.concat([headerWithDocumentTypeInsideVoid, segment]);
}
