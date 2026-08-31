import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const packageStore = path.join(process.cwd(), 'node_modules', '.pnpm');
const patchedStoreEntry = fs
  .readdirSync(packageStore)
  .find((entry) => entry.startsWith('image-size@1.2.1_patch_hash='));
assert.ok(patchedStoreEntry, 'the patched image-size package must be installed');
const imageSizePath = path.join(packageStore, patchedStoreEntry, 'node_modules', 'image-size');

test('zero-length image records and boxes return within the parser budget', () => {
  const fixtures = [
    ['ICNS entry', Buffer.concat([box(16, 'icns'), Buffer.from('icm#'), uint32(0)])],
    ['HEIF box', Buffer.concat([box(16, 'ftyp'), Buffer.from('heic'), box(8, 'junk')])],
    [
      'JXL box',
      Buffer.concat([box(8, 'JXL '), box(8, 'junk'), box(16, 'ftyp'), Buffer.from('jxl ')]),
    ],
  ];

  for (const [name, input] of fixtures) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const imageSize = require(${JSON.stringify(imageSizePath)}); try { imageSize.imageSize(Buffer.from(${JSON.stringify(input.toString('base64'))}, 'base64')); } catch {}`,
      ],
      { encoding: 'utf8', timeout: 1000 },
    );
    assert.equal(result.error, undefined, `${name} exceeded the parser budget`);
    assert.equal(result.signal, null, `${name} was terminated instead of returning`);
  }
});

function box(size, type) {
  return Buffer.concat([uint32(size), Buffer.from(type)]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}
