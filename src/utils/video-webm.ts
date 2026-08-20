import fs from 'node:fs';

const WEBM_PROBE_BYTES = 1024 * 1024;

const ID = {
  block: 0xa1,
  blockGroup: 0xa0,
  cluster: 0x1f43b675,
  codecId: 0x86,
  documentType: 0x4282,
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  simpleBlock: 0xa3,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  tracks: 0x1654ae6b,
  trackType: 0x83,
} as const;

type EbmlElement = Readonly<{
  id: number;
  dataStart: number;
  dataEnd: number;
  nextOffset: number;
  complete: boolean;
  unknownSize: boolean;
}>;

type EbmlVariableInteger = Readonly<{
  length: number;
  value: number;
  unknown: boolean;
}>;

export function hasPlayableWebmStructure(filePath: string): boolean {
  const source = readWebmProbe(filePath);
  if (!source) return false;
  const { bytes, fileSize } = source;
  const header = readEbmlElement(bytes, 0, bytes.length, fileSize);
  if (!header || header.id !== ID.ebml || !header.complete || header.unknownSize) return false;
  if (!hasWebmDocumentType(bytes, header)) return false;

  const segment = readEbmlElement(bytes, header.nextOffset, bytes.length, fileSize);
  if (!segment || segment.id !== ID.segment || !hasPlausibleExtent(segment, fileSize)) return false;
  return hasVideoTrackWithMedia(bytes, segment, fileSize);
}

function readWebmProbe(filePath: string): { bytes: Buffer; fileSize: number } | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const fileSize = fs.fstatSync(fd).size;
      if (fileSize <= 0) return undefined;
      const bytes = Buffer.alloc(Math.min(fileSize, WEBM_PROBE_BYTES));
      return fs.readSync(fd, bytes, 0, bytes.length, 0) === bytes.length
        ? { bytes, fileSize }
        : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

function hasWebmDocumentType(bytes: Buffer, header: EbmlElement): boolean {
  const children = readCompleteChildren(bytes, header);
  const documentType = children?.find((child) => child.id === ID.documentType);
  return (
    documentType !== undefined &&
    bytes.toString('ascii', documentType.dataStart, documentType.dataEnd) === 'webm'
  );
}

function hasVideoTrackWithMedia(bytes: Buffer, segment: EbmlElement, fileSize: number): boolean {
  const videoTracks = new Set<number>();
  const mediaTracks = new Set<number>();
  for (let offset = segment.dataStart; offset < segment.dataEnd;) {
    const child = readEbmlElement(bytes, offset, segment.dataEnd, fileSize);
    if (!child || !hasPlausibleExtent(child, fileSize)) return false;
    if (child.id === ID.tracks) collectVideoTracks(bytes, child, videoTracks);
    if (child.id === ID.cluster) collectMediaTracks(bytes, child, fileSize, mediaTracks);
    if (setsIntersect(videoTracks, mediaTracks)) return true;
    if (!child.complete || child.unknownSize) return false;
    offset = child.nextOffset;
  }
  return false;
}

function collectVideoTracks(bytes: Buffer, tracks: EbmlElement, result: Set<number>): void {
  const children = readCompleteChildren(bytes, tracks);
  if (!children) return;
  for (const child of children) {
    if (child.id === ID.trackEntry) {
      const track = readVideoTrack(bytes, child);
      if (track !== undefined) result.add(track);
    }
  }
}

function readVideoTrack(bytes: Buffer, entry: EbmlElement): number | undefined {
  const children = readCompleteChildren(bytes, entry);
  const number = readUnsignedChild(bytes, children, ID.trackNumber);
  const type = readUnsignedChild(bytes, children, ID.trackType);
  const codecElement = children?.find((child) => child.id === ID.codecId);
  const codec = codecElement
    ? bytes.toString('ascii', codecElement.dataStart, codecElement.dataEnd)
    : undefined;
  return type === 1 && codec?.startsWith('V_') ? number : undefined;
}

function collectMediaTracks(
  bytes: Buffer,
  cluster: EbmlElement,
  fileSize: number,
  result: Set<number>,
): void {
  for (let offset = cluster.dataStart; offset < cluster.dataEnd;) {
    const child = readEbmlElement(bytes, offset, cluster.dataEnd, fileSize);
    if (!child || !hasPlausibleExtent(child, fileSize)) return;
    if (child.id === ID.simpleBlock) addMediaTrack(bytes, child, result);
    if (child.id === ID.blockGroup) collectBlockGroupMedia(bytes, child, result);
    if (!child.complete || child.unknownSize) return;
    offset = child.nextOffset;
  }
}

function collectBlockGroupMedia(bytes: Buffer, group: EbmlElement, result: Set<number>): void {
  const block = readCompleteChildren(bytes, group)?.find((child) => child.id === ID.block);
  if (block) addMediaTrack(bytes, block, result);
}

function addMediaTrack(bytes: Buffer, block: EbmlElement, result: Set<number>): void {
  if (!block.complete || block.unknownSize) return;
  const track = readEbmlVariableInteger(bytes, block.dataStart);
  if (!track || track.unknown || block.dataEnd - block.dataStart < track.length + 4) return;
  result.add(track.value);
}

function readUnsignedInteger(bytes: Buffer, element: EbmlElement): number | undefined {
  const length = element.dataEnd - element.dataStart;
  if (length < 1 || length > 6) return undefined;
  let value = 0;
  for (let offset = element.dataStart; offset < element.dataEnd; offset += 1) {
    value = value * 256 + bytes[offset]!;
  }
  return Number.isSafeInteger(value) ? value : undefined;
}

function readUnsignedChild(
  bytes: Buffer,
  children: readonly EbmlElement[] | undefined,
  id: number,
): number | undefined {
  const element = children?.find((child) => child.id === id);
  return element ? readUnsignedInteger(bytes, element) : undefined;
}

function readCompleteChildren(bytes: Buffer, parent: EbmlElement): EbmlElement[] | undefined {
  if (!parent.complete || parent.unknownSize) return undefined;
  const children: EbmlElement[] = [];
  for (let offset = parent.dataStart; offset < parent.dataEnd;) {
    const child = readEbmlElement(bytes, offset, parent.dataEnd, bytes.length);
    if (!child || !child.complete || child.unknownSize) return undefined;
    children.push(child);
    offset = child.nextOffset;
  }
  return children;
}

function readEbmlElement(
  bytes: Buffer,
  offset: number,
  parentEnd: number,
  fileSize: number,
): EbmlElement | undefined {
  const id = readEbmlId(bytes, offset);
  if (!id) return undefined;
  const size = readEbmlVariableInteger(bytes, offset + id.length);
  if (!size) return undefined;
  const dataStart = offset + id.length + size.length;
  if (dataStart > parentEnd) return undefined;
  const declaredEnd = size.unknown ? fileSize : dataStart + size.value;
  if (!Number.isSafeInteger(declaredEnd) || declaredEnd < dataStart) return undefined;
  return {
    id: id.value,
    dataStart,
    dataEnd: Math.min(declaredEnd, parentEnd),
    nextOffset: declaredEnd,
    complete: declaredEnd <= parentEnd,
    unknownSize: size.unknown,
  };
}

function readEbmlId(bytes: Buffer, offset: number): { length: number; value: number } | undefined {
  const length = readVariableIntegerLength(bytes, offset, 4);
  if (!length) return undefined;
  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + bytes[offset + index]!;
  return { length, value };
}

function readEbmlVariableInteger(bytes: Buffer, offset: number): EbmlVariableInteger | undefined {
  const length = readVariableIntegerLength(bytes, offset, 8);
  if (!length) return undefined;
  const first = bytes[offset]!;
  const mask = 0x80 >> (length - 1);
  const unknown =
    (first & (mask - 1)) === mask - 1 &&
    bytes.subarray(offset + 1, offset + length).every((byte) => byte === 0xff);
  if (unknown) return { length, value: 0, unknown: true };
  let value = first & (mask - 1);
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[offset + index]!;
  }
  return Number.isSafeInteger(value) ? { length, value, unknown: false } : undefined;
}

function readVariableIntegerLength(
  bytes: Buffer,
  offset: number,
  maximum: number,
): number | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let mask = 0x80;
  let length = 1;
  while ((first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  return length <= maximum && offset + length <= bytes.length ? length : undefined;
}

function hasPlausibleExtent(element: EbmlElement, fileSize: number): boolean {
  return element.unknownSize || element.nextOffset <= fileSize;
}

function setsIntersect(left: ReadonlySet<number>, right: ReadonlySet<number>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}
