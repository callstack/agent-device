import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';

// Binary AndroidManifest assembly following AOSP `androidfw/ResourceTypes.h`, so the attribute
// offset rule is proven against the format, not an opaque blob. Each knob exists for a shape the
// parser must handle or refuse instead of misreading. The committed fixtures below come from one
// aapt2-built APK declaring the fixture package; regenerate with `aapt2 compile` + `aapt2 link`
// against a platform `android.jar`, then `unzip -p app.apk AndroidManifest.xml >
// src/fixtures/android-manifest-binary.fixture` and `cp app.apk
// src/fixtures/android-manifest-apk.apk`.
export const ANDROID_MANIFEST_FIXTURE_PACKAGE = 'com.callstack.agentdevicelab';
export const ANDROID_MANIFEST_BINARY_FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/android-manifest-binary.fixture', import.meta.url),
);
export const ANDROID_MANIFEST_APK_FIXTURE_PATH = fileURLToPath(
  new URL('./fixtures/android-manifest-apk.apk', import.meta.url),
);

const RES_XML_TYPE = 0x0003;
export const RES_STRING_POOL_TYPE = 0x0001;
const RES_XML_START_NAMESPACE_TYPE = 0x0100;
const RES_XML_END_NAMESPACE_TYPE = 0x0101;
export const RES_XML_START_ELEMENT_TYPE = 0x0102;
const RES_XML_END_ELEMENT_TYPE = 0x0103;
const RES_XML_RESOURCE_MAP_TYPE = 0x0180;
export const RES_XML_NODE_HEADER_SIZE = 16;
export const RES_XML_ATTR_EXT_SIZE = 20;
export const RES_XML_ATTRIBUTE_SIZE = 20;
const RES_VALUE_SIZE = 8;
const NO_INDEX = 0xffffffff;
const TYPE_STRING = 0x03;
const UTF8_FLAG = 0x100;
const ANDROID_NAMESPACE_URI = 'http://schemas.android.com/apk/res/android';

export type SyntheticAttribute = Readonly<{ name: string; value: string }>;

export type SyntheticManifest = Readonly<{
  packageName?: string;
  elementName?: string;
  attributes?: readonly SyntheticAttribute[];
  utf8Strings?: boolean;
  /** Carry the package only in `typedValue`, leaving `rawValue` as `NO_INDEX`. */
  typedValueOnly?: boolean;
  /** Where the `package` attribute sits among the manifest attributes. */
  packagePosition?: 'last' | number;
  nodeHeaderSize?: number;
  attributeStride?: number;
  attrExtSize?: number;
  /** Declare `attributeStart` elsewhere than right after the extension. */
  attributeStartOverride?: number;
  /** Declare the manifest start-element chunk smaller than its emitted bytes. */
  startElementChunkSizeShrink?: number;
  paddingStrings?: number;
}>;

export function buildBinaryAndroidManifest(input: SyntheticManifest = {}): Buffer {
  const packageName = input.packageName ?? ANDROID_MANIFEST_FIXTURE_PACKAGE;
  const elementName = input.elementName ?? 'manifest';
  const utf8Strings = input.utf8Strings ?? false;
  const extraAttributes = input.attributes ?? [];
  const attributeStride = input.attributeStride ?? RES_XML_ATTRIBUTE_SIZE;
  const attrExtSize = input.attrExtSize ?? RES_XML_ATTR_EXT_SIZE;
  const nodeHeaderSize = input.nodeHeaderSize ?? RES_XML_NODE_HEADER_SIZE;

  const packageAttribute: SyntheticAttribute = { name: 'package', value: packageName };
  const attributes = [...extraAttributes];
  // `splice` clamps an out-of-range index, so any number up to `attributes.length` is first.
  const position = input.packagePosition ?? 0;
  attributes.splice(position === 'last' ? attributes.length : position, 0, packageAttribute);

  const pool = new StringPool([elementName, 'android', ANDROID_NAMESPACE_URI, 'package']);
  pool.add(packageName);
  for (const attribute of attributes) pool.add(attribute.name).add(attribute.value);
  for (let index = 0; index < (input.paddingStrings ?? 0); index += 1) pool.add(`unused${index}`);

  const attributeBuffers = attributes.map((attribute) =>
    buildAttribute(
      pool,
      attribute,
      attribute === packageAttribute,
      attributeStride,
      attribute === packageAttribute ? input.typedValueOnly : false,
    ),
  );

  const attrExt = Buffer.alloc(attrExtSize);
  // aapt2 declares the root element without a namespace; `attrExtSize` may carry extra fields
  // past the six known ones, which a reader must skip without misaligning the array.
  attrExt.writeUInt32LE(NO_INDEX, 0);
  attrExt.writeUInt32LE(pool.indexOf(elementName), 4);
  attrExt.writeUInt16LE(input.attributeStartOverride ?? attrExtSize, 8);
  attrExt.writeUInt16LE(attributeStride, 10);
  attrExt.writeUInt16LE(attributeBuffers.length, 12);

  const startElementBody = Buffer.concat([attrExt, ...attributeBuffers]);
  const startElementChunk = buildNodeChunk(
    RES_XML_START_ELEMENT_TYPE,
    nodeHeaderSize,
    startElementBody,
    input.startElementChunkSizeShrink,
  );

  const chunks = Buffer.concat([
    pool.build(utf8Strings),
    buildChunk(RES_XML_RESOURCE_MAP_TYPE, 8, Buffer.alloc(4)),
    buildNamespaceChunk(RES_XML_START_NAMESPACE_TYPE, nodeHeaderSize, pool),
    startElementChunk,
    buildEndElementChunk(nodeHeaderSize, pool, elementName),
    buildNamespaceChunk(RES_XML_END_NAMESPACE_TYPE, nodeHeaderSize, pool),
  ]);

  const header = Buffer.alloc(8);
  header.writeUInt16LE(RES_XML_TYPE, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + chunks.length, 4);
  return Buffer.concat([header, chunks]);
}

export type BinaryManifestChunk = Readonly<{
  offset: number;
  type: number;
  headerSize: number;
  chunkSize: number;
}>;

// Declared chunk inventory, so a test can mutate one named chunk without re-deriving offsets.
export function listBinaryManifestChunks(manifest: Buffer): BinaryManifestChunk[] {
  const chunks: BinaryManifestChunk[] = [];
  for (let offset = manifest.readUInt16LE(2); offset + 8 <= manifest.length;) {
    const type = manifest.readUInt16LE(offset);
    const headerSize = manifest.readUInt16LE(offset + 2);
    const chunkSize = manifest.readUInt32LE(offset + 4);
    chunks.push({ offset, type, headerSize, chunkSize });
    if (chunkSize < 8) return chunks;
    offset += chunkSize;
  }
  return chunks;
}

class StringPool {
  private readonly names: string[] = [];

  constructor(names: readonly string[]) {
    for (const name of names) this.add(name);
  }

  add(name: string): this {
    if (!this.names.includes(name)) this.names.push(name);
    return this;
  }

  indexOf(name: string): number {
    const index = this.names.indexOf(name);
    if (index < 0) throw new Error(`string pool has no entry for ${name}`);
    return index;
  }

  build(utf8: boolean): Buffer {
    const payloads = this.names.map((value) => encodePoolString(value, utf8));
    const table = Buffer.alloc(this.names.length * 4);
    let stringsLength = 0;
    payloads.forEach((payload, index) => {
      table.writeUInt32LE(stringsLength, index * 4);
      stringsLength += payload.length;
    });
    const headerSize = 28;
    const stringsStart = headerSize + this.names.length * 4;
    const padding = Buffer.alloc((4 - (stringsLength % 4)) % 4);
    const header = Buffer.alloc(headerSize);
    header.writeUInt16LE(RES_STRING_POOL_TYPE, 0);
    header.writeUInt16LE(headerSize, 2);
    header.writeUInt32LE(stringsStart + stringsLength + padding.length, 4);
    header.writeUInt32LE(this.names.length, 8);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(utf8 ? UTF8_FLAG : 0, 16);
    header.writeUInt32LE(stringsStart, 20);
    header.writeUInt32LE(0, 24);
    return Buffer.concat([header, table, ...payloads, padding]);
  }
}

function buildAttribute(
  pool: StringPool,
  attribute: SyntheticAttribute,
  isPackage: boolean,
  declaredStride: number,
  typedValueOnly: boolean | undefined,
): Buffer {
  // Records are sized by the declared stride, so a manifest can claim a stride it lacks.
  const buffer = Buffer.alloc(Math.max(declaredStride, 8));
  // aapt2 leaves `package` unnamespaced; `typedValue.size` is the Res_value width, not zero.
  writeUInt32IfFits(buffer, isPackage ? NO_INDEX : pool.indexOf('android'), 0);
  writeUInt32IfFits(buffer, pool.indexOf(attribute.name), 4);
  const valueIndex = pool.indexOf(attribute.value);
  writeUInt32IfFits(buffer, typedValueOnly ? NO_INDEX : valueIndex, 8);
  writeUInt8IfFits(buffer, RES_VALUE_SIZE, 12);
  if (15 < buffer.length) buffer.writeUInt8(TYPE_STRING, 15);
  writeUInt32IfFits(buffer, valueIndex, 16);
  return buffer;
}

function buildNamespaceChunk(type: number, nodeHeaderSize: number, pool: StringPool): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(pool.indexOf('android'), 0);
  body.writeUInt32LE(pool.indexOf(ANDROID_NAMESPACE_URI), 4);
  return buildNodeChunk(type, nodeHeaderSize, body);
}

function buildEndElementChunk(nodeHeaderSize: number, pool: StringPool, name: string): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt32LE(pool.indexOf(name), 4);
  return buildNodeChunk(RES_XML_END_ELEMENT_TYPE, nodeHeaderSize, body);
}

// aapt2 emits a real line number and no comment; node headers also carry the declared shrink
// a refusal case needs.
function buildNodeChunk(type: number, nodeHeaderSize: number, body: Buffer, shrink = 0): Buffer {
  return buildChunk(type, nodeHeaderSize, body, shrink, (header) => {
    writeUInt32IfFits(header, 1, 8);
    writeUInt32IfFits(header, NO_INDEX, 12);
  });
}

function buildChunk(
  type: number,
  headerSize: number,
  body: Buffer,
  shrink = 0,
  decorate?: (header: Buffer) => void,
): Buffer {
  const header = Buffer.alloc(Math.max(headerSize, 8));
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(headerSize, 2);
  header.writeUInt32LE(header.length + body.length - shrink, 4);
  decorate?.(header);
  return Buffer.concat([header.subarray(0, headerSize), body]);
}

function writeUInt32IfFits(buffer: Buffer, value: number, offset: number): void {
  if (offset + 4 <= buffer.length) buffer.writeUInt32LE(value, offset);
}

function writeUInt8IfFits(buffer: Buffer, value: number, offset: number): void {
  if (offset < buffer.length) buffer.writeUInt8(value, offset);
}

function encodePoolString(value: string, utf8: boolean): Buffer {
  if (utf8) {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([
      writeLength8(value.length),
      writeLength8(bytes.length),
      bytes,
      Buffer.from([0]),
    ]);
  }
  const header = Buffer.alloc(2);
  header.writeUInt16LE(value.length, 0);
  return Buffer.concat([header, Buffer.from(value, 'utf16le'), Buffer.from([0, 0])]);
}

function writeLength8(value: number): Buffer {
  if (value < 0x80) return Buffer.from([value]);
  return Buffer.from([(value >> 8) | 0x80, value & 0xff]);
}

// Minimal ZIP writer storing entries uncompressed, so a synthetic manifest reaches
// `resolveAndroidArchivePackageName` through the same `unzip -p` extraction the product uses.
export function buildStoredZipArchive(entries: ReadonlyMap<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const crc = crc32(content) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    parts.push(local, nameBuffer, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + content.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.size, 8);
  end.writeUInt16LE(entries.size, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}
