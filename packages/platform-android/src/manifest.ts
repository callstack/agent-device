import path from 'node:path';
import { TextDecoder } from 'node:util';
import { runCmd } from '@agent-device/host-kit/command';
import { resolveAndroidSdkRoots } from './sdk.ts';
import { requireAndroidAdbHost } from './adb-host.ts';

const RES_XML_TYPE = 0x0003;
const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_ELEMENT_TYPE = 0x0102;
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
  if (buffer.length < 8 || buffer.readUInt16LE(0) !== RES_XML_TYPE) {
    return undefined;
  }

  let strings: string[] | undefined;
  for (let offset = buffer.readUInt16LE(2); offset + 8 <= buffer.length;) {
    const type = buffer.readUInt16LE(offset);
    const headerSize = buffer.readUInt16LE(offset + 2);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkSize <= 0 || offset + chunkSize > buffer.length) {
      return undefined;
    }

    if (type === RES_STRING_POOL_TYPE) {
      strings = parseStringPool(buffer.subarray(offset, offset + chunkSize));
    } else if (type === RES_XML_START_ELEMENT_TYPE && strings) {
      const packageName = parseStartElementPackageName(buffer, offset, headerSize, strings);
      if (packageName) return packageName;
    }
    offset += chunkSize;
  }

  return undefined;
}

function parseStartElementPackageName(
  buffer: Buffer,
  chunkOffset: number,
  headerSize: number,
  strings: string[],
): string | undefined {
  if (headerSize < 36 || chunkOffset + headerSize > buffer.length) {
    return undefined;
  }
  const nameIndex = buffer.readUInt32LE(chunkOffset + 20);
  if (strings[nameIndex] !== 'manifest') {
    return undefined;
  }
  const attributeStart = buffer.readUInt16LE(chunkOffset + 24);
  const attributeSize = buffer.readUInt16LE(chunkOffset + 26);
  const attributeCount = buffer.readUInt16LE(chunkOffset + 28);
  const firstAttributeOffset = chunkOffset + attributeStart;
  for (let index = 0; index < attributeCount; index += 1) {
    const attributeOffset = firstAttributeOffset + index * attributeSize;
    if (attributeOffset + 20 > buffer.length) {
      return undefined;
    }
    const attributeName = strings[buffer.readUInt32LE(attributeOffset + 4)];
    if (attributeName !== 'package') continue;

    const rawValueIndex = buffer.readUInt32LE(attributeOffset + 8);
    if (rawValueIndex !== NO_INDEX) {
      return strings[rawValueIndex];
    }
    const dataType = buffer.readUInt8(attributeOffset + 15);
    const data = buffer.readUInt32LE(attributeOffset + 16);
    if (dataType === TYPE_STRING) {
      return strings[data];
    }
    return undefined;
  }
  return undefined;
}

function parseStringPool(chunk: Buffer): string[] {
  if (chunk.length < 28) return [];
  const stringCount = chunk.readUInt32LE(8);
  const flags = chunk.readUInt32LE(16);
  const stringsStart = chunk.readUInt32LE(20);
  const isUtf8 = (flags & UTF8_FLAG) !== 0;
  const offsetsStart = 28;
  const strings: string[] = [];

  for (let index = 0; index < stringCount; index += 1) {
    const offsetPosition = offsetsStart + index * 4;
    if (offsetPosition + 4 > chunk.length) return strings;
    const stringOffset = chunk.readUInt32LE(offsetPosition);
    const absoluteOffset = stringsStart + stringOffset;
    strings.push(
      isUtf8 ? readUtf8String(chunk, absoluteOffset) : readUtf16String(chunk, absoluteOffset),
    );
  }

  return strings;
}

function readUtf8String(chunk: Buffer, offset: number): string {
  const [, utf16LengthBytes] = readLength8(chunk, offset);
  const [byteLength, byteLengthBytes] = readLength8(chunk, offset + utf16LengthBytes);
  const start = offset + utf16LengthBytes + byteLengthBytes;
  return chunk.subarray(start, start + byteLength).toString('utf8');
}

function readUtf16String(chunk: Buffer, offset: number): string {
  const [charLength, lengthBytes] = readLength16(chunk, offset);
  const start = offset + lengthBytes;
  return utf16Decoder.decode(chunk.subarray(start, start + charLength * 2));
}

function readLength8(chunk: Buffer, offset: number): [number, number] {
  const first = chunk.readUInt8(offset);
  if ((first & 0x80) === 0) return [first, 1];
  const second = chunk.readUInt8(offset + 1);
  return [((first & 0x7f) << 8) | second, 2];
}

function readLength16(chunk: Buffer, offset: number): [number, number] {
  const first = chunk.readUInt16LE(offset);
  if ((first & 0x8000) === 0) return [first, 2];
  const second = chunk.readUInt16LE(offset + 2);
  return [((first & 0x7fff) << 16) | second, 4];
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
    for (const sdkRoot of resolveAndroidSdkRoots()) {
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
