import path from 'node:path';
import { isRecord } from '../../../utils/parsing.ts';
import type {
  AppleImage,
  CrashArtifact,
  IpsDocument,
  IpsFrameMatch,
  SymbolicatedAddress,
  TextFrameMatch,
} from './types.ts';
import {
  addressKey,
  normalizeUuid,
  parseAtosSymbol,
  readJsonRecord,
  readBigIntField,
  readIntegerNumberField,
  readString,
  single,
} from './utils.ts';

const TEXT_IMAGE_ARCH_RE = /^(?:arm64e?|arm64_32|x86_64|armv7[sk]?|i386)$/;

export function readAppleCrashArtifact(text: string): CrashArtifact | null {
  return readIpsArtifact(text) ?? readTextCrashArtifact(text);
}

function readIpsArtifact(text: string): CrashArtifact | null {
  const document = readIpsDocument(text);
  if (!document) return null;
  const rawImages = Array.isArray(document.payload.usedImages) ? document.payload.usedImages : [];
  const images = rawImages.flatMap((entry, index) => readIpsImage(entry, index));
  if (images.length === 0) return null;

  const rawThreads = Array.isArray(document.payload.threads) ? document.payload.threads : [];
  const frameMatches = readIpsFrameMatches(rawThreads, images);

  return {
    format: 'ips',
    images,
    addresses: frameMatches.map(({ frame: _frame, ...address }) => address),
    document,
    frameMatches,
    write: (addressMap) => writeIpsArtifact(document, frameMatches, addressMap),
  };
}

function readIpsDocument(text: string): IpsDocument | null {
  const wholeDocument = readJsonRecord(text);
  if (wholeDocument) return { payload: wholeDocument };
  const newlineIndex = text.indexOf('\n');
  if (newlineIndex === -1) return null;
  const header = text.slice(0, newlineIndex);
  const payload = readJsonRecord(text.slice(newlineIndex + 1));
  return payload ? { header, payload } : null;
}

function readIpsFrameMatches(rawThreads: unknown[], images: AppleImage[]): IpsFrameMatch[] {
  const imageByIndex = new Map(images.map((image) => [image.index, image]));
  return rawThreads.flatMap((thread, threadIndex) =>
    readIpsFrameRecords(thread).flatMap((frame, frameIndex) =>
      readIpsFrameMatch(frame, imageByIndex, threadIndex, frameIndex),
    ),
  );
}

function readIpsFrameRecords(thread: unknown): Record<string, unknown>[] {
  if (!isRecord(thread) || !Array.isArray(thread.frames)) return [];
  return thread.frames.filter(isRecord);
}

function readIpsFrameMatch(
  frame: Record<string, unknown>,
  imageByIndex: Map<number | undefined, AppleImage>,
  threadIndex: number,
  frameIndex: number,
): IpsFrameMatch[] {
  const imageIndex = readIntegerNumberField(frame, 'imageIndex', 'IPS frame');
  const imageOffset = readBigIntField(frame, 'imageOffset', 'IPS frame');
  if (imageIndex === undefined || imageOffset === undefined) return [];
  const image = imageByIndex.get(imageIndex);
  return image
    ? [{ frame, frameIndex, threadIndex, image, address: image.base + imageOffset }]
    : [];
}

function writeIpsArtifact(
  document: IpsDocument,
  frameMatches: IpsFrameMatch[],
  addressMap: Map<string, SymbolicatedAddress>,
): string {
  for (const match of frameMatches) {
    const symbol = addressMap.get(addressKey(match.image, match.address))?.text;
    if (symbol) writeIpsFrameSymbol(match.frame, symbol);
  }
  document.payload.agentDeviceSymbolication = {
    tool: 'agent-device debug symbols',
    symbolicatedFrames: [...addressMap.values()].filter((entry) => entry.text).length,
  };
  const payload = `${JSON.stringify(document.payload, null, 2)}\n`;
  return document.header ? `${document.header}\n${payload}` : payload;
}

function writeIpsFrameSymbol(frame: Record<string, unknown>, symbol: string): void {
  const parsed = parseAtosSymbol(symbol);
  frame.symbol = parsed.symbol;
  if (parsed.location !== undefined) frame.symbolLocation = parsed.location;
}

function readIpsImage(value: unknown, index: number): AppleImage[] {
  if (!isRecord(value)) return [];
  const uuid = normalizeUuid(readString(value.uuid));
  const base = readBigIntField(value, 'base', 'IPS usedImages');
  if (!uuid || base === undefined) return [];
  const pathValue = readString(value.path);
  return [
    {
      index,
      name: readString(value.name) ?? (pathValue ? path.basename(pathValue) : `image-${index}`),
      uuid,
      arch: readString(value.arch),
      base,
      path: pathValue,
    },
  ];
}

function readTextCrashArtifact(text: string): CrashArtifact | null {
  const lines = text.split('\n');
  const images = readTextImages(lines);
  if (images.length === 0) return null;
  const frameMatches = readTextFrameMatches(lines, images);
  return {
    format: 'text',
    images,
    addresses: frameMatches,
    lines,
    frameMatches,
    write(addressMap) {
      const framesByLine = new Map(frameMatches.map((frame) => [frame.lineIndex, frame]));
      return lines
        .map((line, lineIndex) => {
          const frame = framesByLine.get(lineIndex);
          if (!frame) return line;
          const symbol = addressMap.get(addressKey(frame.image, frame.address))?.text;
          if (!symbol || line.includes(symbol)) return line;
          return `${line}  // ${symbol}`;
        })
        .join('\n');
    },
  };
}

function readTextImages(lines: string[]): AppleImage[] {
  const images: AppleImage[] = [];
  const binaryImagesIndex = lines.findIndex((line) => /^Binary Images:/i.test(line.trim()));
  if (binaryImagesIndex === -1) return images;
  for (const line of lines.slice(binaryImagesIndex + 1)) {
    const image = readTextImageLine(line);
    if (image) images.push(image);
  }
  return images;
}

function readTextImageLine(line: string): AppleImage | null {
  const match = line.match(
    /^\s*(0x[0-9a-fA-F]+)\s*-\s*(0x[0-9a-fA-F]+)\s+\+?(.+?)\s+<([0-9a-fA-F-]{32,36})>\s+(.+)$/,
  );
  if (!match) return null;
  const uuid = normalizeUuid(match[4]);
  if (!uuid) return null;
  const parsedName = readTextImageNameAndArch(match[3]!.trim(), match[5]!.trim());
  return {
    name: parsedName.name,
    arch: parsedName.arch,
    uuid,
    base: BigInt(match[1]!),
    end: BigInt(match[2]!),
    path: match[5]!.trim(),
  };
}

function readTextImageNameAndArch(
  rawName: string,
  imagePath: string,
): { name: string; arch?: string } {
  const tokens = rawName.split(/\s+/);
  const maybeArch = tokens.at(-1);
  if (maybeArch && TEXT_IMAGE_ARCH_RE.test(maybeArch)) {
    return { name: tokens.slice(0, -1).join(' ').trim(), arch: maybeArch };
  }
  const executableName = path.basename(imagePath);
  return { name: rawName.startsWith(executableName) ? executableName : rawName };
}

function readTextFrameMatches(lines: string[], images: AppleImage[]): TextFrameMatch[] {
  const matches: TextFrameMatch[] = [];
  let crashedStackThreadIndex: number | undefined;
  for (const [lineIndex, line] of lines.entries()) {
    const heading = line.match(/^Thread\s+(\d+)\s+Crashed:/);
    if (heading) crashedStackThreadIndex = Number(heading[1]);
    else if (line.trim().length === 0 || /^Thread\s+\d+/.test(line)) {
      crashedStackThreadIndex = undefined;
    }
    const frame = readTextFrameLine(line, images);
    const indexMatch = line.match(/^\s*(\d+)/);
    if (frame && indexMatch) {
      matches.push({
        ...frame,
        frameIndex: Number(indexMatch[1]),
        lineIndex,
        threadIndex: crashedStackThreadIndex,
      });
    }
  }
  return matches;
}

function readTextFrameLine(line: string, images: AppleImage[]): SymbolicatedAddress | null {
  const match = line.match(/^\s*\d+\s+(.+?)\s+(0x[0-9a-fA-F]+)\b/);
  if (!match) return null;
  const imageName = match[1]!.trim();
  const address = BigInt(match[2]!);
  const image = findTextFrameImage(images, imageName, address);
  if (!image) return null;
  return { image, address };
}

function findTextFrameImage(
  images: AppleImage[],
  imageName: string,
  address: bigint,
): AppleImage | undefined {
  const matches = images.filter((candidate) => candidate.name === imageName);
  return matches.find((candidate) => imageContainsAddress(candidate, address)) ?? single(matches);
}

function imageContainsAddress(image: AppleImage, address: bigint): boolean {
  return image.end !== undefined && image.base <= address && address <= image.end;
}
