import { test } from 'vitest';
import assert from 'node:assert/strict';
import { pngTruecolorChannels, readPngChunks, readPngHeader } from './png-format.ts';
import { corruptChunkChecksum, encodeFixturePng, rampPixels } from './png-codec.fixtures.ts';

const TRUECOLOR_RGB = 2;
const TRUECOLOR_RGBA = 6;

test('the header reports the layout the IHDR declares', () => {
  const buffer = encodeFixturePng(rgbaFixture(7, 3));

  assert.deepEqual(readPngHeader(buffer), {
    width: 7,
    height: 3,
    bitDepth: 8,
    colorType: TRUECOLOR_RGBA,
    compressionMethod: 0,
    filterMethod: 0,
    interlace: 0,
  });
});

test('bytes that are too short or mis-signed have no header', () => {
  assert.equal(readPngHeader(Buffer.alloc(0)), null);
  assert.equal(readPngHeader(Buffer.alloc(28)), null);
  assert.equal(readPngHeader(Buffer.from('png-looking bytes that are long enough')), null);
});

test('a first chunk that is not IHDR has no header', () => {
  const buffer = Buffer.from(encodeFixturePng(rgbaFixture(4, 4)));
  buffer.write('tEXt', 12, 'ascii');

  assert.equal(readPngHeader(buffer), null);
});

test('only the truecolor layouts have a channel count here', () => {
  assert.equal(pngTruecolorChannels(TRUECOLOR_RGB), 3);
  assert.equal(pngTruecolorChannels(TRUECOLOR_RGBA), 4);
  assert.equal(pngTruecolorChannels(0), null);
  assert.equal(pngTruecolorChannels(3), null);
  assert.equal(pngTruecolorChannels(4), null);
});

test('the chunk walk starts at IHDR and runs through IEND', () => {
  const buffer = encodeFixturePng({
    ...rgbaFixture(4, 3),
    ancillary: { type: 'tEXt', data: Buffer.from('label\0crop', 'ascii') },
  });

  assert.deepEqual(
    readPngChunks(buffer)!.map((chunk) => chunk.type),
    ['IHDR', 'tEXt', 'IDAT', 'IEND'],
  );
});

test('a chunk sequence that is truncated, corrupted, or never ends is refused', () => {
  const buffer = encodeFixturePng(rgbaFixture(4, 3));

  assert.equal(readPngChunks(buffer.subarray(0, buffer.length - 6)), null);
  assert.equal(readPngChunks(corruptChunkChecksum(buffer, 'IEND')), null);
  assert.equal(readPngChunks(Buffer.from(SIGNATURE_BYTES)), null);
});

test('bytes that do not start with the PNG signature have no chunks', () => {
  assert.equal(readPngChunks(Buffer.from('JFIF-looking bytes that are long enough to walk')), null);
});

test('a chunk that claims to be critical but is not one of the four is refused', () => {
  const buffer = encodeFixturePng({
    ...rgbaFixture(4, 3),
    ancillary: { type: 'CUty', data: new Uint8Array([1, 2, 3]) },
  });

  assert.equal(readPngChunks(buffer), null);
});

test('bytes trailing IEND are refused, because no conforming reader reaches them', () => {
  const buffer = encodeFixturePng(rgbaFixture(4, 3));

  assert.equal(readPngChunks(Buffer.concat([buffer, Buffer.from([0, 0, 1, 2, 255])])), null);
});

test('a corrupted IHDR checksum is refused, so its dimensions are never trusted', () => {
  const buffer = corruptChunkChecksum(encodeFixturePng(rgbaFixture(4, 3)), 'IHDR');

  assert.equal(readPngChunks(buffer), null);
});

const SIGNATURE_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function rgbaFixture(width: number, height: number) {
  return {
    pixels: rampPixels(width, height, 4),
    width,
    height,
    channels: 4,
    colorType: TRUECOLOR_RGBA,
  };
}
