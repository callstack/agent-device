import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const packageStore = path.join(process.cwd(), 'node_modules', '.pnpm');
const patchHash = /^ {2}image-size@1\.2\.1: ([0-9a-f]{64})$/m.exec(
  fs.readFileSync(path.join(process.cwd(), 'pnpm-lock.yaml'), 'utf8'),
)?.[1];
assert.ok(patchHash, 'the lockfile must record the image-size patch hash');
const imageSizePath =
  process.env.IMAGE_SIZE_PACKAGE_DIR ??
  path.join(packageStore, `image-size@1.2.1_patch_hash=${patchHash}`, 'node_modules', 'image-size');
assert.ok(fs.existsSync(imageSizePath), 'the image-size package must be installed');

test('zero-length image records and boxes return within the parser budget', () => {
  const fixtures = [
    [
      'ICNS entry',
      Buffer.concat([Buffer.from('icns'), uint32(16), Buffer.from('icm#'), uint32(0)]),
      'icns',
    ],
    [
      'HEIF box',
      Buffer.concat([box(16, 'ftyp'), Buffer.from('heic'), Buffer.alloc(4), zeroBox('junk')]),
      'Invalid HEIF, no size found',
    ],
    [
      'JXL box',
      Buffer.concat([
        box(8, 'JXL '),
        box(16, 'ftyp'),
        Buffer.from('jxl '),
        Buffer.alloc(4),
        zeroBox('junk'),
      ]),
      'No codestream found in JXL container',
    ],
    [
      'JXL zero-size jxlp box',
      Buffer.concat([
        box(8, 'JXL '),
        box(16, 'ftyp'),
        Buffer.from('jxl '),
        Buffer.alloc(4),
        zeroBox('jxlp'),
      ]),
      'No codestream found in JXL container',
    ],
  ];
  const selectedFixtures = process.env.IMAGE_SIZE_FIXTURE
    ? fixtures.filter(([name]) => name === process.env.IMAGE_SIZE_FIXTURE)
    : fixtures;
  assert.equal(selectedFixtures.length > 0, true, 'the selected fixture must exist');

  for (const [name, input, expected] of selectedFixtures) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const imageSize = require(${JSON.stringify(imageSizePath)}); const input = Buffer.from(${JSON.stringify(input.toString('base64'))}, 'base64'); try { const result = imageSize.imageSize(input); if (${JSON.stringify(expected)} !== 'icns' || result.type !== 'icns' || result.width !== 16 || result.height !== 16) process.exitCode = 1; } catch (error) { if (${JSON.stringify(expected)} === 'icns' || error.message !== ${JSON.stringify(expected)}) process.exitCode = 1; }`,
      ],
      { encoding: 'utf8', timeout: 1000 },
    );
    assert.equal(result.error, undefined, `${name} exceeded the parser budget`);
    assert.equal(result.signal, null, `${name} was terminated instead of returning`);
    assert.equal(result.status, 0, `${name} did not take the expected parser route`);
  }
});

function box(size, type) {
  return Buffer.concat([uint32(size), Buffer.from(type)]);
}

function zeroBox(type) {
  return Buffer.concat([uint32(0), Buffer.from(type)]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}
