import { parseXmlDocumentSync, type XmlNode } from '@agent-device/xml';
import type { ReasonTable } from '@agent-device/kernel/errors';

/**
 * Reads one Apple property list — XML text or `bplist00` binary — into plain JS values, with no
 * third-party plist parser. A downloaded app's `Info.plist` and a simulator's preference file are the
 * documents read here.
 *
 * Each stored form maps to the JS value its name states: a dictionary becomes an own-property object,
 * an array an array, `<string>` and a binary ASCII or UTF-16 string a string, `<integer>` and `<real>`
 * a number, `<true>`/`<false>` and the binary singletons a boolean, `<null>` and the binary null a
 * `null`, `<date>` and a binary date a `Date`, `<data>` and binary data a `Uint8Array`, and a binary
 * unique id `{ UID: number }`. A key equal to `__proto__` becomes an own property like any other, so a
 * document cannot repoint an object's prototype.
 *
 * A document this reader cannot model is refused with `ApplePlistParseError` rather than answered with
 * a partial value. `malformed` means the bytes or tags are damaged, refer to themselves, or exceed the
 * budgets below; `unsupported type` means the document is well formed but names a value kind or a
 * dictionary key type this reader does not model.
 *
 * A writer that de-duplicates repeats one reference instead of repeating the object it names. Such an
 * object is decoded once, so the positions that reference it answer the same object.
 */

/** A value an Apple property list holds. */
export type ApplePlistValue =
  | null
  | boolean
  | number
  | string
  | Date
  | Uint8Array
  | ApplePlistValue[]
  | ApplePlistRecord;

/** One Apple property list dictionary. */
export type ApplePlistRecord = { readonly [key: string]: ApplePlistValue };

/** Why an Apple property list document cannot become a JS value. */
export const APPLE_PLIST_PARSE_REASONS = {
  // The document is damaged, refers to itself, or is larger than a reader's budget.
  malformed: { reason: 'apple_plist_malformed' },
  // The document is well formed but names a value kind or key type this reader does not model.
  unsupportedType: { reason: 'apple_plist_unsupported_type' },
} as const satisfies ReasonTable<'apple plist'>;

/** Why an Apple property list cannot become a JS value. */
export type ApplePlistParseReason =
  (typeof APPLE_PLIST_PARSE_REASONS)[keyof typeof APPLE_PLIST_PARSE_REASONS]['reason'];

/** An Apple property list that cannot become a JS value. */
export class ApplePlistParseError extends Error {
  readonly reason: ApplePlistParseReason;

  constructor(reason: ApplePlistParseReason, message: string) {
    super(message);
    this.name = 'ApplePlistParseError';
    this.reason = reason;
  }
}

const BINARY_MAGIC = 'bplist00';
const BINARY_TRAILER_BYTES = 32;
/** The values, including every nested entry, one binary document may hold at most. */
const MAX_BINARY_VALUES = 100_000;
/**
 * How deeply binary objects may nest before the reader refuses the document. The XML walker applies a
 * bound of the same size to its elements, and both stop far below the depth that would exhaust the JS
 * stack. Real plists nest a handful of levels.
 */
const MAX_BINARY_NESTING_DEPTH = 256;
const MAX_NUMBER_BYTES = 8;
/**
 * The text one XML `<integer>` holds: an optional sign, then decimal digits, or `0x` and hex digits —
 * the grammar `plutil` accepts. Nothing else is read as a number.
 */
const XML_INTEGER_TEXT = /^[+-]?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/;
/** The text one XML `<real>` holds: a decimal literal with at least one digit, no hex and no suffix. */
const XML_REAL_TEXT = /^[+-]?(?:[0-9]*\.[0-9]+|[0-9]+\.[0-9]*|[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
/** Seconds between the Apple reference date, 2001-01-01, and the JS one. */
const APPLE_EPOCH_SECONDS = 978_307_200;
const MAX_DATE_MS = 8.64e15;
/** Code units decoded per step, so `String.fromCharCode` never receives a huge argument list. */
const STRING_CHUNK_UNITS = 1_024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Reads the dictionary an Apple property list holds, from XML text or `bplist00` bytes.
 *
 * Returns `null` when the document names no dictionary: a value that is an array or a scalar. Throws
 * `ApplePlistParseError` for a document this reader cannot model, including a text document that is not
 * XML at all, such as a legacy OpenStep plist.
 *
 * The refusals go past what a permissive reader answers, so a caller sees one typed error instead of a
 * value it cannot represent: an XML `<integer>` or `<real>` whose text is not exactly a number, or names
 * an integer beyond `Number.MAX_SAFE_INTEGER`; an XML `<real>` such as `nan`; an XML `<date>` no `Date`
 * holds; a `<plist>` holding more than one value; a binary dictionary key that is not a string; a binary
 * integer wider than eight bytes; and a binary object kind this reader does not model.
 */
export function parseApplePlist(bytes: Uint8Array): Record<string, unknown> | null {
  return asRecord(
    startsWithBinaryMagic(bytes)
      ? readBinaryPlistValue(bytes)
      : readXmlPlistValue(new TextDecoder().decode(bytes)),
  ) as Record<string, unknown> | null;
}

function startsWithBinaryMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < BINARY_MAGIC.length) return false;
  for (let index = 0; index < BINARY_MAGIC.length; index += 1) {
    if (bytes[index] !== BINARY_MAGIC.charCodeAt(index)) return false;
  }
  return true;
}

function asRecord(value: unknown): ApplePlistRecord | null {
  if (value === null || typeof value !== 'object' || value instanceof Uint8Array) return null;
  return Array.isArray(value) || value instanceof Date ? null : (value as ApplePlistRecord);
}

/** Reads the value an XML property list names below its `<plist>` element. */
function readXmlPlistValue(plist: string): ApplePlistValue {
  const nodes = readXmlDocument(plist);
  const root = nodes.find((node) => node.name === 'plist');
  if (!root) throw malformed('no <plist> element was found');
  if (root.children.length > 1) throw malformed('<plist> holds more than one value');
  const valueNode = root.children[0];
  return valueNode ? readXmlPlistNode(valueNode) : null;
}

/**
 * Parses plist XML, reporting a document the XML walker rejects as the same malformed plist a broken
 * binary document gets, so callers catch one error type from one module.
 *
 * Text is not trimmed. Apple reads `<string>  v  </string>` as a padded string and a `<key>` the way it
 * is written, so a plist read here answers the same text the `plutil` and `plistlib` parsers do.
 */
function readXmlDocument(plist: string): XmlNode[] {
  try {
    return parseXmlDocumentSync(plist, { trimText: false });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'the XML document was rejected';
    throw malformed(detail.replace(/\.$/, ''));
  }
}

function readXmlPlistNode(node: XmlNode): ApplePlistValue {
  switch (node.name) {
    case 'dict':
      return readXmlPlistDict(node);
    case 'array':
      return node.children.map(readXmlPlistNode);
    case 'string':
      return node.text ?? '';
    case 'integer':
      return readXmlInteger(node);
    case 'real':
      return readXmlReal(node);
    case 'true':
      return true;
    case 'false':
      return false;
    case 'null':
      return null;
    case 'date':
      return requireXmlDate(node);
    case 'data':
      return readBase64(node.text ?? '');
    default:
      throw unsupported(`plist tag <${node.name}>`);
  }
}

/**
 * Reads a `<dict>` as alternating `<key>` and value children. A `<key>` with no value after it holds an
 * empty string, the way Apple's own readers treat a trailing key.
 */
function readXmlPlistDict(node: XmlNode): ApplePlistRecord {
  const entries: [string, ApplePlistValue][] = [];
  for (let index = 0; index < node.children.length; index += 2) {
    const keyNode = node.children[index]!;
    if (keyNode.name !== 'key') throw malformed(`a <dict> entry starts with <${keyNode.name}>`);
    const valueNode = node.children[index + 1];
    entries.push([keyNode.text ?? '', valueNode ? readXmlPlistNode(valueNode) : '']);
  }
  return Object.fromEntries(entries);
}

/**
 * Reads an XML `<integer>`. Its text must be the whole number, so a prefix such as `12abc` is refused
 * rather than read as 12, and a value beyond `MAX_SAFE_INTEGER` is refused like the binary reader
 * refuses it, so both forms answer one number the same way.
 */
function readXmlInteger(node: XmlNode): number {
  const text = node.text ?? '';
  if (!XML_INTEGER_TEXT.test(text)) throw malformed(`text "${text}" as <integer>`);
  const digits = text.replace(/^[+-]/, '');
  // BigInt parses hex and decimal digits without a leading sign, which the text grammar already checked.
  const magnitude = BigInt(digits);
  if (magnitude > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw malformed(`integer ${text} beyond an exact JS number`);
  }
  return text.startsWith('-') ? -Number(magnitude) : Number(magnitude);
}

/** Reads an XML `<real>`, whose text must be the whole decimal literal, with no suffix or spaces. */
function readXmlReal(node: XmlNode): number {
  const text = node.text ?? '';
  if (!XML_REAL_TEXT.test(text)) throw malformed(`text "${text}" as <real>`);
  return requireXmlNumber(node, Number.parseFloat(text));
}

function requireXmlNumber(node: XmlNode, value: number): number {
  if (!Number.isFinite(value)) throw malformed(`text "${node.text ?? ''}" as <${node.name}>`);
  return value;
}

function requireXmlDate(node: XmlNode): Date {
  const date = new Date(node.text ?? '');
  if (Number.isNaN(date.getTime())) throw malformed(`text "${node.text ?? ''}" as <date>`);
  return date;
}

/** Reads an XML `<data>` element, whose base64 text Apple wraps across lines. */
function readBase64(text: string): Uint8Array {
  const compact = text.replaceAll(/\s+/g, '');
  if (!BASE64.test(compact)) throw malformed('text inside <data> is not base64');
  return Uint8Array.from(atob(compact), (char) => char.charCodeAt(0));
}

/** Byte positions inside the trailer that name the document's own geometry. */
const TRAILER_OFFSET_INT_SIZE = 6;
const TRAILER_OBJECT_REF_SIZE = 7;
const TRAILER_OBJECT_COUNT = 8;
const TRAILER_TOP_OBJECT = 16;
const TRAILER_OFFSET_TABLE = 24;

/** The marker nibble Apple assigns each binary object kind. */
const KIND_SINGLETON = 0x0;
const KIND_INT = 0x1;
const KIND_REAL = 0x2;
const KIND_DATE = 0x3;
const KIND_DATA = 0x4;
const KIND_ASCII = 0x5;
const KIND_UTF16 = 0x6;
const KIND_UID = 0x8;
const KIND_ARRAY = 0xa;
const KIND_DICT = 0xd;
/** A low nibble of this value means the real length follows as an `<int>` object. */
const EXTENDED_LENGTH_NIBBLE = 0x0f;

/**
 * Reads one `bplist00` document through its header and trailer. Every offset, length and object
 * reference is checked against the document before it is read, an object cannot appear inside itself,
 * and the document as a whole gets `MAX_BINARY_VALUES` values.
 */
class BinaryPlistReader {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private readonly offsetIntSize: number;
  private readonly objectRefSize: number;
  private readonly objectCount: number;
  private readonly topObject: number;
  private readonly offsetTableOffset: number;
  private readonly openObjects = new Set<number>();
  private readonly decoded = new Map<number, ApplePlistValue>();
  private valueBudget = MAX_BINARY_VALUES;

  private constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const trailer = bytes.byteLength - BINARY_TRAILER_BYTES;
    this.offsetIntSize = this.readTrailerSize(trailer + TRAILER_OFFSET_INT_SIZE, 'offset size');
    this.objectRefSize = this.readTrailerSize(
      trailer + TRAILER_OBJECT_REF_SIZE,
      'object reference size',
    );
    this.objectCount = this.readNumberAt(trailer + TRAILER_OBJECT_COUNT, 'object count');
    this.topObject = this.readNumberAt(trailer + TRAILER_TOP_OBJECT, 'top object');
    this.offsetTableOffset = this.readNumberAt(trailer + TRAILER_OFFSET_TABLE, 'offset table');
    this.require(this.objectCount <= bytes.byteLength, 'object count');
    this.require(this.topObject < this.objectCount, 'top object');
    this.require(
      this.offsetTableOffset + this.objectCount * this.offsetIntSize <= bytes.byteLength,
      'offset table',
    );
  }

  static open(bytes: Uint8Array): BinaryPlistReader {
    if (bytes.byteLength < BINARY_MAGIC.length + BINARY_TRAILER_BYTES) {
      throw malformed('it is shorter than a header and a trailer');
    }
    return new BinaryPlistReader(bytes);
  }

  /** Reads the document's top-level object. */
  readTopValue(): ApplePlistValue {
    return this.readObjectByIndex(this.topObject);
  }

  /**
   * Reads one object by index. `openObjects` holds the indices on the path from the top object down, so
   * its size is the current nesting depth: it both refuses an object that contains itself and refuses a
   * chain too deep to walk before it exhausts the JS stack. `decoded` holds one value per index, so an
   * object many other objects reference is decoded once, which keeps a document's cost proportional to
   * the document rather than to how often it repeats a reference.
   */
  private readObjectByIndex(index: number): ApplePlistValue {
    this.require(index < this.objectCount, 'object reference past the object count');
    if (this.valueBudget <= 0) throw malformed('it holds too many values');
    this.valueBudget -= 1;
    const decoded = this.decoded.get(index);
    if (decoded !== undefined) return decoded;
    if (this.openObjects.has(index)) throw malformed('an object contains itself');
    if (this.openObjects.size >= MAX_BINARY_NESTING_DEPTH) {
      throw malformed(`an object nested deeper than ${MAX_BINARY_NESTING_DEPTH} levels`);
    }
    this.openObjects.add(index);
    try {
      const value = this.readObjectAt(this.offsetOfObject(index));
      this.decoded.set(index, value);
      return value;
    } finally {
      this.openObjects.delete(index);
    }
  }

  private readObjectAt(offset: number): ApplePlistValue {
    const marker = this.readUint8(offset);
    const kind = marker >> 4;
    const nibble = marker & 0x0f;
    switch (kind) {
      case KIND_SINGLETON:
        return readSingleton(marker);
      case KIND_INT:
        return this.readIntAt(offset, nibble);
      case KIND_REAL:
        return this.readRealAt(offset, nibble);
      case KIND_DATE:
        return this.readDateAt(offset, nibble);
      case KIND_DATA:
        return this.readDataAt(offset, nibble);
      case KIND_ASCII:
        return this.readTextAt(offset, nibble, 1);
      case KIND_UTF16:
        return this.readTextAt(offset, nibble, 2);
      case KIND_UID:
        return { UID: this.readUnsignedAt(offset + 1, nibble + 1, 'unique id') };
      case KIND_ARRAY:
        return this.readArrayAt(offset, nibble);
      case KIND_DICT:
        return this.readDictAt(offset, nibble);
      default:
        throw unsupported(`binary plist object type 0x${kind.toString(16)}`);
    }
  }

  private readIntAt(offset: number, nibble: number): number {
    const byteCount = 1 << nibble;
    if (byteCount > MAX_NUMBER_BYTES) throw malformed(`integer of ${byteCount} bytes`);
    this.requireRange(offset + 1, byteCount);
    if (byteCount < MAX_NUMBER_BYTES) return this.readUnsigned(offset + 1, byteCount);
    const value = this.view.getBigInt64(offset + 1);
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw malformed('integer beyond an exact JS number');
    }
    return Number(value);
  }

  private readRealAt(offset: number, nibble: number): number {
    const byteCount = 1 << nibble;
    this.requireRange(offset + 1, byteCount);
    if (byteCount === 4) return this.view.getFloat32(offset + 1);
    if (byteCount === 8) return this.view.getFloat64(offset + 1);
    throw malformed(`real of ${byteCount} bytes`);
  }

  private readDateAt(offset: number, nibble: number): Date {
    if (nibble !== 3) throw malformed('date of a size other than 8 bytes');
    this.requireRange(offset + 1, MAX_NUMBER_BYTES);
    const timestamp = (APPLE_EPOCH_SECONDS + this.view.getFloat64(offset + 1)) * 1000;
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > MAX_DATE_MS) {
      throw malformed('date beyond the range a Date holds');
    }
    return new Date(timestamp);
  }

  private readDataAt(offset: number, nibble: number): Uint8Array {
    const { length, payload } = this.readLengthAt(offset, nibble);
    this.requireRange(payload, length);
    return this.bytes.subarray(payload, payload + length).slice();
  }

  /**
   * Reads an ASCII (`unit` 1) or UTF-16BE (`unit` 2) string, whose length counts code units. An ASCII
   * byte becomes the code point of the same value; Apple writes non-ASCII text as UTF-16.
   */
  private readTextAt(offset: number, nibble: number, unit: number): string {
    const { length, payload } = this.readLengthAt(offset, nibble);
    this.requireRange(payload, length * unit);
    const chunks: string[] = [];
    for (let done = 0; done < length; done += STRING_CHUNK_UNITS) {
      const units = Math.min(STRING_CHUNK_UNITS, length - done);
      const codes = new Array<number>(units);
      for (let unitIndex = 0; unitIndex < units; unitIndex += 1) {
        const at = payload + (done + unitIndex) * unit;
        codes[unitIndex] = unit === 1 ? this.view.getUint8(at) : this.view.getUint16(at);
      }
      chunks.push(String.fromCharCode(...codes));
    }
    return chunks.join('');
  }

  private readArrayAt(offset: number, nibble: number): ApplePlistValue[] {
    const { length, payload } = this.readLengthAt(offset, nibble);
    this.requireRange(payload, length * this.objectRefSize);
    const values: ApplePlistValue[] = [];
    for (let index = 0; index < length; index += 1) {
      values.push(
        this.readObjectByIndex(this.readObjectRefAt(payload + index * this.objectRefSize)),
      );
    }
    return values;
  }

  /** Reads every key before any value, so one failed key refuses the whole dictionary. */
  private readDictAt(offset: number, nibble: number): ApplePlistRecord {
    const { length, payload } = this.readLengthAt(offset, nibble);
    this.requireRange(payload, 2 * length * this.objectRefSize);
    const keys: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = this.readObjectByIndex(
        this.readObjectRefAt(payload + index * this.objectRefSize),
      );
      if (typeof key !== 'string') {
        throw unsupported('binary plist dictionary key that is not a string');
      }
      keys.push(key);
    }
    const entries: [string, ApplePlistValue][] = [];
    for (let index = 0; index < length; index += 1) {
      const value = this.readObjectByIndex(
        this.readObjectRefAt(payload + (length + index) * this.objectRefSize),
      );
      entries.push([keys[index]!, value]);
    }
    return Object.fromEntries(entries);
  }

  /** The declared length of a string, data, array or dictionary, and where its payload starts. */
  private readLengthAt(offset: number, nibble: number): { length: number; payload: number } {
    if (nibble !== EXTENDED_LENGTH_NIBBLE) return { length: nibble, payload: offset + 1 };
    const lengthMarker = this.readUint8(offset + 1);
    if (lengthMarker >> 4 !== KIND_INT) throw malformed('object length that is not an integer');
    const size = 1 << (lengthMarker & 0x0f);
    const length = this.readUnsignedAt(offset + 2, size, 'object length');
    return { length, payload: offset + 2 + size };
  }

  private readObjectRefAt(offset: number): number {
    return this.readUnsignedAt(offset, this.objectRefSize, 'object reference');
  }

  private offsetOfObject(index: number): number {
    const entry = this.offsetTableOffset + index * this.offsetIntSize;
    this.requireRange(entry, this.offsetIntSize);
    const offset = this.readUnsigned(entry, this.offsetIntSize);
    this.requireRange(offset, 1);
    return offset;
  }

  private readTrailerSize(offset: number, what: string): number {
    const size = this.readUint8(offset);
    if (size < 1 || size > MAX_NUMBER_BYTES) throw malformed(`${what} of ${size} bytes`);
    return size;
  }

  /** The trailer's own fields, which Apple stores unsigned across eight bytes. */
  private readNumberAt(offset: number, what: string): number {
    return this.readUnsignedAt(offset, MAX_NUMBER_BYTES, what);
  }

  private readUnsignedAt(offset: number, size: number, what: string): number {
    if (size < 1 || size > MAX_NUMBER_BYTES) throw malformed(`${what} of ${size} bytes`);
    this.requireRange(offset, size);
    return this.readUnsigned(offset, size);
  }

  private readUint8(offset: number): number {
    this.requireRange(offset, 1);
    return this.view.getUint8(offset);
  }

  /** Reads `size` big-endian bytes as one unsigned number, the width Apple writes at most. */
  private readUnsigned(offset: number, size: number): number {
    let value = 0;
    for (let index = 0; index < size; index += 1) {
      value = value * 256 + this.view.getUint8(offset + index);
    }
    return value;
  }

  private requireRange(offset: number, length: number): void {
    this.require(
      Number.isSafeInteger(offset) &&
        offset >= 0 &&
        Number.isSafeInteger(length) &&
        length >= 0 &&
        offset + length <= this.bytes.byteLength,
      'bytes past the end of the document',
    );
  }

  private require(holds: boolean, detail: string): void {
    if (!holds) throw malformed(detail);
  }
}

function readBinaryPlistValue(bytes: Uint8Array): ApplePlistValue {
  if (textPrefix(bytes) !== BINARY_MAGIC) throw malformed(`it does not start with ${BINARY_MAGIC}`);
  return BinaryPlistReader.open(bytes).readTopValue();
}

function textPrefix(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes.subarray(0, BINARY_MAGIC.length));
}

function readSingleton(marker: number): boolean | null {
  if (marker === 0x00) return null;
  if (marker === 0x08) return false;
  if (marker === 0x09) return true;
  throw malformed(`singleton marker 0x${marker.toString(16)}`);
}

function malformed(detail: string): ApplePlistParseError {
  return new ApplePlistParseError(
    APPLE_PLIST_PARSE_REASONS.malformed.reason,
    `Malformed Apple plist: ${detail}.`,
  );
}

function unsupported(detail: string): ApplePlistParseError {
  return new ApplePlistParseError(
    APPLE_PLIST_PARSE_REASONS.unsupportedType.reason,
    `Unsupported Apple plist: ${detail}.`,
  );
}
