import zlib from 'node:zlib';

/**
 * The layout a PNG file declares in its IHDR chunk and the chunks that follow it, read without
 * decoding pixels. A declared layout whose checksum does not match is declined like any other
 * unrecognised layout, so nobody acts on dimensions the file itself does not vouch for.
 *
 * `null` means the bytes do not describe something this package understands, which is a decline
 * rather than a diagnosis: callers route to the general PNG reader, which owns the canonical
 * decode error.
 */

const SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_DATA_OFFSET = 16;
const HEADER_BYTES = IHDR_DATA_OFFSET + 13;
const IHDR_TYPE_OFFSET = 12;
const IHDR_CHECKSUM_OFFSET = HEADER_BYTES;
const FIRST_CHUNK_OFFSET = 8;
const CHUNK_ENVELOPE_BYTES = 12;
const MAX_CHUNK_BYTES = 0x7fffffff;
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;
const CRITICAL_CHUNKS: readonly string[] = ['IHDR', 'PLTE', 'IDAT', 'IEND'];
const CHUNK_TYPE_PATTERN = /^[A-Za-z]{4}$/;

export type PngHeader = Readonly<{
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  compressionMethod: number;
  filterMethod: number;
  interlace: number;
}>;

export type PngChunk = Readonly<{ type: string; data: Uint8Array }>;

// A chunk name is four ASCII letters, and one starting with an uppercase letter is critical. The
// format defines exactly four critical names, so any other claim to be critical is a file no
// conforming reader accepts.
function isUntrustworthyChunkType(type: string): boolean {
  if (!CHUNK_TYPE_PATTERN.test(type)) return true;
  return type[0]! <= 'Z' && !CRITICAL_CHUNKS.includes(type);
}

function hasSignature(bytes: Uint8Array): boolean {
  return SIGNATURE.every((byte, index) => bytes[index] === byte);
}

export function readPngHeader(bytes: Uint8Array): PngHeader | null {
  if (bytes.length < IHDR_CHECKSUM_OFFSET + 4 || !hasSignature(bytes)) return null;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.readUInt32BE(8) !== 13 ||
    view.toString('ascii', IHDR_TYPE_OFFSET, IHDR_DATA_OFFSET) !== 'IHDR'
  )
    return null;
  const checksummed = view.subarray(IHDR_TYPE_OFFSET, IHDR_CHECKSUM_OFFSET);
  if (view.readUInt32BE(IHDR_CHECKSUM_OFFSET) !== zlib.crc32(checksummed) >>> 0) return null;
  return {
    width: view.readUInt32BE(IHDR_DATA_OFFSET),
    height: view.readUInt32BE(IHDR_DATA_OFFSET + 4),
    bitDepth: bytes[IHDR_DATA_OFFSET + 8]!,
    colorType: bytes[IHDR_DATA_OFFSET + 9]!,
    compressionMethod: bytes[IHDR_DATA_OFFSET + 10]!,
    filterMethod: bytes[IHDR_DATA_OFFSET + 11]!,
    interlace: bytes[IHDR_DATA_OFFSET + 12]!,
  };
}

/** Bytes per pixel of a truecolor layout, or `null` for a layout the region reader declines. */
export function pngTruecolorChannels(colorType: number): 3 | 4 | null {
  if (colorType === COLOR_TYPE_RGB) return 3;
  if (colorType === COLOR_TYPE_RGBA) return 4;
  return null;
}

/**
 * The chunk sequence from `IHDR` to `IEND`, each with its checksum verified.
 *
 * `null` reports a sequence that cannot be trusted: a length running past the end of the buffer,
 * a checksum that does not match, an unrecognised critical chunk, a file that never reaches `IEND`,
 * or bytes trailing it. Callers own any further chunk they decline to interpret.
 */
export function readPngChunks(bytes: Uint8Array): PngChunk[] | null {
  if (!hasSignature(bytes)) return null;
  const reader = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = FIRST_CHUNK_OFFSET;
  while (offset + CHUNK_ENVELOPE_BYTES <= bytes.length) {
    const length = reader.readUInt32BE(offset);
    if (length > MAX_CHUNK_BYTES || offset + CHUNK_ENVELOPE_BYTES + length > bytes.length) {
      return null;
    }
    const checksummed = reader.subarray(offset + 4, offset + 8 + length);
    if (reader.readUInt32BE(offset + 8 + length) !== zlib.crc32(checksummed) >>> 0) return null;
    const type = reader.toString('ascii', offset + 4, offset + 8);
    if (isUntrustworthyChunkType(type)) return null;
    chunks.push({ type, data: reader.subarray(offset + 8, offset + 8 + length) });
    // `IEND` is the end of the stream, so bytes after it are content no conforming reader sees.
    if (type === 'IEND') {
      return offset + CHUNK_ENVELOPE_BYTES + length === bytes.length ? chunks : null;
    }
    offset += CHUNK_ENVELOPE_BYTES + length;
  }
  return null;
}
