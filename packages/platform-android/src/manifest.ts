import path from 'node:path';
import { TextDecoder } from 'node:util';
import { runCmd } from '@agent-device/host-kit/command';
import { resolveAndroidSdkRoots } from './sdk.ts';
import { requireAndroidAdbHost } from './adb-host.ts';

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
// ResChunk_header: type + headerSize + chunkSize. A ResXMLTree_header is nothing but one.
const RES_CHUNK_HEADER_SIZE = 8;
// ResXMLTree_node: ResChunk_header + lineNumber + comment.
const RES_XML_NODE_HEADER_SIZE = 16;
// ResXMLTree_attrExt: ns + name + attributeStart/Size/Count + id/class/styleIndex.
const RES_XML_ATTR_EXT_SIZE = 20;
// ResXMLTree_attribute: ns + name + rawValue + typedValue.
const RES_XML_ATTRIBUTE_SIZE = 20;
// ResStringPool_header: ResChunk_header + stringCount/styleCount/flags/stringsStart/stylesStart.
const RES_STRING_POOL_HEADER_SIZE = 28;
const UTF8_FLAG = 0x100;
const TYPE_STRING = 0x03;
const NO_INDEX = 0xffffffff;

const utf16Decoder = new TextDecoder('utf-16le');
let aaptPathCache: string | null | undefined;

export async function resolveAndroidArchivePackageName(
  archivePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const entry of ['AndroidManifest.xml', 'base/manifest/AndroidManifest.xml']) {
    const manifest = await readZipEntry(archivePath, entry, signal);
    if (!manifest) continue;
    const packageName = parseAndroidManifestPackageName(manifest);
    if (packageName) return packageName;
  }
  return await resolveAndroidArchivePackageNameWithAapt(archivePath, signal);
}

async function readZipEntry(
  archivePath: string,
  entry: string,
  signal?: AbortSignal,
): Promise<Buffer | undefined> {
  try {
    const result = await runCmd('unzip', ['-p', archivePath, entry], {
      allowFailure: true,
      binaryStdout: true,
      signal,
    });
    if (result.exitCode !== 0 || !result.stdoutBuffer || result.stdoutBuffer.length === 0) {
      return undefined;
    }
    return result.stdoutBuffer;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function parseAndroidManifestPackageName(manifest: Buffer): string | undefined {
  const textCandidate = manifest
    .subarray(0, Math.min(manifest.length, 128))
    .toString('utf8')
    .trimStart();
  if (textCandidate.startsWith('<')) {
    return parseTextManifestPackageName(manifest.toString('utf8'));
  }
  return parseBinaryManifestPackageName(manifest);
}

function parseTextManifestPackageName(text: string): string | undefined {
  const match = text.match(/<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/i);
  return match?.[1];
}

function parseBinaryManifestPackageName(buffer: Buffer): string | undefined {
  const dataEnd = readBinaryTreeDataEnd(buffer);
  if (!dataEnd) return undefined;

  let strings: AndroidManifestStrings | undefined;
  for (let offset = dataEnd.treeHeaderSize; offset + RES_CHUNK_HEADER_SIZE <= dataEnd.dataEnd;) {
    const chunk = readChunkHeader(buffer, offset, dataEnd.dataEnd);
    if (!chunk) return undefined;

    if (chunk.type === RES_STRING_POOL_TYPE) {
      strings = parseStringPool(buffer.subarray(offset, offset + chunk.chunkSize));
      if (!strings) return undefined;
    } else if (strings) {
      const packageName = parsePackageInChunk(buffer, chunk, offset, strings);
      if (packageName) return packageName;
    }
    offset += chunk.chunkSize;
  }

  return undefined;
}

type BinaryChunkHeader = Readonly<{ type: number; headerSize: number; chunkSize: number }>;

function readChunkHeader(
  buffer: Buffer,
  offset: number,
  dataEnd: number,
): BinaryChunkHeader | undefined {
  const type = buffer.readUInt16LE(offset);
  const headerSize = buffer.readUInt16LE(offset + 2);
  const chunkSize = buffer.readUInt32LE(offset + 4);
  if (!isChunkHeaderValid(headerSize, chunkSize) || offset + chunkSize > dataEnd) {
    return undefined;
  }
  return { type, headerSize, chunkSize };
}

function parsePackageInChunk(
  buffer: Buffer,
  chunk: BinaryChunkHeader,
  offset: number,
  strings: AndroidManifestStrings,
): string | undefined {
  if (chunk.type !== RES_XML_START_ELEMENT_TYPE) {
    return undefined;
  }
  return parseStartElementPackageName(
    buffer,
    offset,
    offset + chunk.chunkSize,
    chunk.headerSize,
    strings,
  );
}

// AOSP `validate_chunk` checks every chunk against the parent's remaining bytes; the declared
// end (`mDataEnd`) — not the buffer end — bounds the walk.
function readBinaryTreeDataEnd(
  buffer: Buffer,
): Readonly<{ treeHeaderSize: number; dataEnd: number }> | undefined {
  if (buffer.length < RES_CHUNK_HEADER_SIZE || buffer.readUInt16LE(0) !== RES_XML_TYPE) {
    return undefined;
  }
  const treeHeaderSize = buffer.readUInt16LE(2);
  const treeSize = buffer.readUInt32LE(4);
  if (!isChunkHeaderValid(treeHeaderSize, treeSize) || treeSize > buffer.length) {
    return undefined;
  }
  return { treeHeaderSize, dataEnd: treeSize };
}

// AOSP `validate_chunk`: a chunk header is readable only when it spans the common header, and
// both it and the chunk size are four-byte aligned with the size at least as large.
function isChunkHeaderValid(headerSize: number, chunkSize: number): boolean {
  return (
    headerSize >= RES_CHUNK_HEADER_SIZE &&
    headerSize % 4 === 0 &&
    chunkSize % 4 === 0 &&
    headerSize <= chunkSize
  );
}

type AndroidAttributeArray = Readonly<{
  firstOffset: number;
  stride: number;
  count: number;
}>;

// An entry is `undefined` when its pool bytes are unreadable, which is a refusal to name that
// string rather than a whole-manifest failure: other attributes may still resolve.
type AndroidManifestStrings = readonly (string | undefined)[];

function parseStartElementPackageName(
  buffer: Buffer,
  chunkOffset: number,
  chunkEnd: number,
  headerSize: number,
  strings: AndroidManifestStrings,
): string | undefined {
  // AOSP `ResXMLParser::next`: a node needs room for the node header AND `ResXMLTree_attrExt`.
  if (headerSize < RES_XML_NODE_HEADER_SIZE) {
    return undefined;
  }
  const extOffset = chunkOffset + headerSize;
  if (extOffset + RES_XML_ATTR_EXT_SIZE > chunkEnd) {
    return undefined;
  }
  if (strings[buffer.readUInt32LE(extOffset + 4)] !== 'manifest') {
    return undefined;
  }
  const attributes = readAttributeArray(buffer, extOffset, chunkEnd);
  return attributes ? readPackageAttribute(buffer, strings, attributes) : undefined;
}

function readAttributeArray(
  buffer: Buffer,
  extOffset: number,
  chunkEnd: number,
): AndroidAttributeArray | undefined {
  const attributeStart = buffer.readUInt16LE(extOffset + 8);
  const stride = buffer.readUInt16LE(extOffset + 10);
  const count = buffer.readUInt16LE(extOffset + 12);
  // AOSP `validateAttributeCounts` also refuses an `attributeStart` overlapping its own extension.
  if (stride < RES_XML_ATTRIBUTE_SIZE || attributeStart < RES_XML_ATTR_EXT_SIZE) {
    return undefined;
  }
  // Attributes address from `ResXMLTree_attrExt`, not the chunk start, and AOSP
  // `validateAttributeCounts` bounds the WHOLE declared array
  // (`attributeStart + stride * count <= chunkSize - headerSize`) before any record is read.
  if (attributeStart + stride * count > chunkEnd - extOffset) {
    return undefined;
  }
  return { firstOffset: extOffset + attributeStart, stride, count };
}

function readPackageAttribute(
  buffer: Buffer,
  strings: AndroidManifestStrings,
  attributes: AndroidAttributeArray,
): string | undefined {
  for (let index = 0; index < attributes.count; index += 1) {
    const offset = attributes.firstOffset + index * attributes.stride;
    if (strings[buffer.readUInt32LE(offset + 4)] !== 'package') continue;
    return readPackageValue(buffer, strings, offset);
  }
  return undefined;
}

function readPackageValue(
  buffer: Buffer,
  strings: AndroidManifestStrings,
  offset: number,
): string | undefined {
  const rawValueIndex = buffer.readUInt32LE(offset + 8);
  if (rawValueIndex !== NO_INDEX) {
    return strings[rawValueIndex];
  }
  const dataType = buffer.readUInt8(offset + 15);
  const data = buffer.readUInt32LE(offset + 16);
  return dataType === TYPE_STRING ? strings[data] : undefined;
}

// Refuses the whole pool when its declared header or table cannot fit (AOSP
// `StringPool::validateChunk`/`unload`); a merely unreadable entry stays `undefined` per entry.
function parseStringPool(chunk: Buffer): AndroidManifestStrings | undefined {
  const headerSize = chunk.readUInt16LE(2);
  const chunkSize = chunk.readUInt32LE(4);
  if (
    !isChunkHeaderValid(headerSize, chunkSize) ||
    headerSize < RES_STRING_POOL_HEADER_SIZE ||
    chunkSize > chunk.length
  ) {
    return undefined;
  }
  const stringCount = chunk.readUInt32LE(8);
  const flags = chunk.readUInt32LE(16);
  const stringsStart = chunk.readUInt32LE(20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;
  // AOSP: the offset table lives at `chunk + headerSize` and must fit before the string data.
  const offsetsStart = headerSize;
  if (
    offsetsStart + stringCount * 4 > chunkSize ||
    stringsStart < offsetsStart + stringCount * 4 ||
    stringsStart >= chunkSize
  ) {
    return undefined;
  }
  const strings: (string | undefined)[] = [];

  for (let index = 0; index < stringCount; index += 1) {
    const absoluteOffset = stringsStart + chunk.readUInt32LE(offsetsStart + index * 4);
    strings.push(
      isUtf8 ? readUtf8String(chunk, absoluteOffset) : readUtf16String(chunk, absoluteOffset),
    );
  }

  return strings;
}

function readUtf8String(chunk: Buffer, offset: number): string | undefined {
  const utf16Length = readUtf8Length(chunk, offset);
  if (!utf16Length) return undefined;
  const byteLength = readUtf8Length(chunk, offset + utf16Length.bytes);
  if (!byteLength) return undefined;
  const start = offset + utf16Length.bytes + byteLength.bytes;
  return withinChunk(chunk, start, byteLength.value)
    ? chunk.subarray(start, start + byteLength.value).toString('utf8')
    : undefined;
}

function readUtf16String(chunk: Buffer, offset: number): string | undefined {
  const charLength = readUtf16Length(chunk, offset);
  if (!charLength) return undefined;
  const start = offset + charLength.bytes;
  return withinChunk(chunk, start, charLength.value * 2)
    ? utf16Decoder.decode(chunk.subarray(start, start + charLength.value * 2))
    : undefined;
}

function withinChunk(chunk: Buffer, start: number, length: number): boolean {
  return (
    Number.isSafeInteger(start) && Number.isSafeInteger(length) && start + length <= chunk.length
  );
}

type PoolLength = Readonly<{ value: number; bytes: number }>;

function readUtf8Length(chunk: Buffer, offset: number): PoolLength | undefined {
  if (offset + 1 > chunk.length) return undefined;
  const first = chunk.readUInt8(offset);
  if ((first & 0x80) === 0) return { value: first, bytes: 1 };
  if (offset + 2 > chunk.length) return undefined;
  return { value: ((first & 0x7f) << 8) | chunk.readUInt8(offset + 1), bytes: 2 };
}

function readUtf16Length(chunk: Buffer, offset: number): PoolLength | undefined {
  if (offset + 2 > chunk.length) return undefined;
  const first = chunk.readUInt16LE(offset);
  if ((first & 0x8000) === 0) return { value: first, bytes: 2 };
  if (offset + 4 > chunk.length) return undefined;
  return { value: ((first & 0x7fff) << 16) | chunk.readUInt16LE(offset + 2), bytes: 4 };
}

async function resolveAndroidArchivePackageNameWithAapt(
  archivePath: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  const aaptPath = await resolveAaptPath();
  if (!aaptPath) return undefined;
  const result = await runCmd(aaptPath, ['dump', 'badging', archivePath], {
    allowFailure: true,
    signal,
  });
  if (result.exitCode !== 0) return undefined;
  const match = result.stdout.match(/package:\s+name='([^']+)'/);
  return match?.[1];
}

async function resolveAaptPath(): Promise<string | undefined> {
  if (aaptPathCache !== undefined) {
    return aaptPathCache ?? undefined;
  }

  try {
    const files = requireAndroidAdbHost().files;
    const { hostPlatform } = await import('@agent-device/host-kit/process');
    for (const sdkRoot of resolveAndroidSdkRoots(undefined, hostPlatform())) {
      const buildToolsDir = path.join(sdkRoot, 'build-tools');
      try {
        const versions = await files.readDirectory(buildToolsDir);
        const sortedVersions = versions.sort((a, b) =>
          b.localeCompare(a, undefined, { numeric: true }),
        );
        for (const version of sortedVersions) {
          const candidate = path.join(buildToolsDir, version, 'aapt');
          // SDK roots can come from env vars; reject relative roots before returning an executable.
          if (path.isAbsolute(candidate) && (await files.isExecutable(candidate))) {
            aaptPathCache = candidate;
            return candidate;
          }
        }
      } catch {
        // Ignore missing build-tools for this SDK root and keep searching.
      }
    }
  } catch {
    // Ignore SDK lookup failures and fall back to undefined.
  }

  aaptPathCache = null;
  return undefined;
}
