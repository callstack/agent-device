import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  APPLE_PLIST_PARSE_REASONS,
  ApplePlistParseError,
  parseApplePlist,
} from '../plist-value.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const bytesOf = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
const xmlDocument = (body: string): Uint8Array =>
  new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${body}</dict></plist>`,
  );

/** Reads a `bplist00` document this test crafts by hand instead of one a tool wrote. */
const binaryDocument = (base64: string): Uint8Array =>
  new Uint8Array(Buffer.from(base64, 'base64'));

/** Asserts a refusal carries the reason its table declares. */
const refusedWith =
  (expected: string) =>
  (error: unknown): boolean =>
    error instanceof ApplePlistParseError && error.reason === expected;

const asDate = (value: unknown): Date => value as Date;
const asBytes = (value: unknown): Uint8Array => value as Uint8Array;

/** The keys the two readers have callers for: app metadata, and a simulator's preference file. */
for (const [label, name] of [
  ['An XML Info.plist', 'info-xml.plist'],
  ['A binary Info.plist', 'info-binary.plist'],
] as const) {
  test(`${label} answers the bundle keys app resolution reads`, () => {
    const plist = parseApplePlist(bytesOf(name))!;
    assert.equal(plist.CFBundleIdentifier, 'com.example.app');
    assert.equal(plist.CFBundleExecutable, 'ExampleApp');
    assert.equal(plist.CFBundleName, 'ExampleApp');
    assert.equal(plist.CFBundleDisplayName, 'Example & App');
    assert.equal(plist.CFBundleShortVersionString, '1.4.2');
    assert.equal(plist.CFBundleVersion, '142');
    assert.equal(plist.UILaunchStoryboardName, 'BootScreen');
    assert.equal(plist.LSRequiresIPhoneOS, true);
    assert.deepEqual(plist.UIDeviceFamily, [1, 2]);
    assert.deepEqual(plist.LSApplicationQueriesSchemes, ['tel', 'mailto']);
    assert.deepEqual(plist.UISupportedInterfaceOrientations, [
      'UIInterfaceOrientationPortrait',
      'UIInterfaceOrientationLandscapeLeft',
    ]);
  });

  test(`${label} answers the nested URL schemes deep-link resolution reads`, () => {
    const plist = parseApplePlist(bytesOf(name))!;
    assert.deepEqual(plist.CFBundleURLTypes, [
      {
        CFBundleTypeRole: 'Editor',
        CFBundleURLName: 'com.example.app.expo',
        CFBundleURLSchemes: ['exp+example', 'example'],
      },
      { CFBundleURLSchemes: ['fb1234567890'] },
    ]);
  });
}

for (const [label, name] of [
  ['XML', 'kinds-xml.plist'],
  ['binary', 'kinds-binary.plist'],
] as const) {
  test(`a ${label} document reads each value kind as its own JS type`, () => {
    const plist = parseApplePlist(bytesOf(name))!;
    assert.equal(plist.String, 'plain');
    assert.equal(plist.EmptyString, '');
    assert.equal(plist.UnicodeString, 'Zürich — 東京');
    assert.equal(plist.Integer, -12);
    assert.equal(plist.BigInteger, 9007199254740991);
    assert.equal(plist.Real, 2.5);
    assert.equal(plist.True, true);
    assert.equal(plist.False, false);
    assert.equal(asDate(plist.Date).getTime(), Date.UTC(2026, 10, 22, 9, 15, 30));
    assert.deepEqual(
      asBytes(plist.Data),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    assert.deepEqual(plist.Array, ['one', 2]);
    assert.deepEqual(plist.EmptyArray, []);
    assert.deepEqual(plist.Nested, { Inner: { Flag: true }, Number: 7 });
    assert.deepEqual(plist.EmptyDict, {});
  });
}

test('an XML document reads a null value the binary format cannot store', () => {
  assert.equal(parseApplePlist(bytesOf('kinds-xml.plist'))!.Null, null);
});

test('the binary preferences fixtures a simulator writes read as the accessibility state they hold', () => {
  assert.equal(
    parseApplePlist(bytesOf('accessibility-true.plist'))!.ApplicationAccessibilityEnabled,
    true,
  );
  assert.equal(
    parseApplePlist(bytesOf('accessibility-false.plist'))!.ApplicationAccessibilityEnabled,
    false,
  );
});

/**
 * The spacing both Apple parsers keep: `plutil -convert json` and `plistlib.loads` answer each of these
 * values, and `plutil -convert binary1` wrote the binary fixture from the XML one.
 */
const paddedValues = {
  '  PaddedKey  ': '  PaddedValue  ',
  Blank: '   ',
  Tabbed: '\tx\t',
  CdataSplit: 'foo  bar  baz',
  CdataSpaced: '\n spaced \n',
  Entities: '  &  ',
  Multiline: 'line1\n\tline2',
  URL: 'https://example.com/a?b=1&c=2',
};

for (const [label, name] of [
  ['XML', 'padded-xml.plist'],
  ['binary', 'padded-binary.plist'],
] as const) {
  test(`a ${label} document keeps the whitespace its strings and keys are written with`, () => {
    assert.deepEqual(parseApplePlist(bytesOf(name)), paddedValues);
  });
}

test('both stored forms answer one padded document with the same values', () => {
  assert.deepEqual(
    parseApplePlist(bytesOf('padded-binary.plist')),
    parseApplePlist(bytesOf('padded-xml.plist')),
  );
});

/**
 * A writer that de-duplicates names one object several times instead of repeating it, so this document
 * holds one ASCII string, object 3, and its array names it in all three slots. Each slot answers the
 * value `plutil -convert json` answers, and decoding one object per index keeps a document's cost
 * proportional to its bytes rather than to how often it repeats a reference.
 */
test('a binary document whose objects share one referenced object reads that object each time', () => {
  assert.deepEqual(
    parseApplePlist(
      binaryDocument(
        'YnBsaXN0MDDRAQJRQaMDAwNSaGkICw0RAAAAAAAAAQEAAAAAAAAABAAAAAAAAAAAAAAAAAAAABQ=',
      ),
    ),
    { A: ['hi', 'hi', 'hi'] },
  );
});

test('an XML dictionary keeps its keys as own properties, including one named __proto__', () => {
  const plist = parseApplePlist(
    xmlDocument('<key>__proto__</key><dict><key>polluted</key><true/></dict>'),
  )!;
  assert.deepEqual(Object.getOwnPropertyDescriptor(plist, '__proto__')?.value, { polluted: true });
  assert.equal(Object.getPrototypeOf(plist), Object.prototype);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('a binary dictionary keeps a key it stores as a separate object', () => {
  // bplist00: a one-entry dictionary whose key is the ASCII string "Key" and whose value is `true`.
  const plist = parseApplePlist(
    binaryDocument('YnBsaXN0MDDRAQJTS2V5CQgLDwAAAAAAAAEBAAAAAAAAAAMAAAAAAAAAAAAAAAAAAAAQ'),
  )!;
  assert.deepEqual(plist, { Key: true });
});

/**
 * Widths one real encoder chose for each value: `plutil -convert binary1` and Python's `plistlib` both
 * write a negative across eight bytes and keep 1-, 2- and 4-byte integers unsigned, which is how Apple's
 * own reader decodes them. Read as signed, `U8High` would come back −128 and `U32Max` −1.
 */
test('a binary integer keeps the sign its byte width carries', () => {
  assert.deepEqual(parseApplePlist(bytesOf('ints-binary.plist')), {
    Neg: -12,
    Neg32: -2147483648,
    SafeMax: 9007199254740991,
    U8High: 128,
    U8Max: 255,
    U16Max: 65535,
    U32Max: 4294967295,
    Zero: 0,
  });
});

test('the XML and binary integer fixtures agree value for value', () => {
  assert.deepEqual(parseApplePlist(bytesOf('ints-xml.plist')), {
    Neg: -12,
    Neg32: -2147483648,
    SafeMax: 9007199254740991,
    U8High: 128,
    U8Max: 255,
    U16Max: 65535,
    U32Max: 4294967295,
    Zero: 0,
  });
});

/** Builds `depth` dictionaries, each holding one entry keyed `k`, the innermost holding `true`. */
function nestedDictXml(depth: number): Uint8Array {
  return new TextEncoder().encode(
    '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">' +
      '<dict><key>k</key>'.repeat(depth) +
      '<true/>' +
      '</dict>'.repeat(depth) +
      '</plist>',
  );
}

/**
 * Builds a `bplist00` of the same shape as `nestedDictXml`: object 2·i is a one-entry dictionary keyed by
 * object 2·i+1 holding object 2·i+2, and the last object is `true`. Every offset and reference is valid,
 * so only the depth tells this document from one a real writer produced.
 */
function nestedDictBinary(depth: number): Uint8Array {
  const ref = (value: number, size: number) =>
    [...Array(size).keys()].reverse().map((shift) => Math.floor(value / 256 ** shift) % 256);
  const objectCount = 2 * depth + 1;
  const refSize = objectCount < 256 ? 1 : objectCount < 65536 ? 2 : 4;
  const payloadAt = (index: number): number[] => {
    if (index % 2 === 1) return [0x51, 0x6b]; // ASCII string "k"
    if (index === objectCount - 1) return [0x09]; // true
    return [0xd1, ...ref(index + 1, refSize), ...ref(index + 2, refSize)];
  };
  const payloads: number[][] = [];
  for (let index = 0; index < objectCount; index += 1) payloads.push(payloadAt(index));
  const bodyBytes = payloads.reduce((total, payload) => total + payload.length, 0);
  const span = 8 + bodyBytes + objectCount * refSize + 32;
  const offsetSize = span < 256 ? 1 : span < 65536 ? 2 : 4;
  const bytes = [...new TextEncoder().encode('bplist00')];
  let cursor = 8;
  const offsets: number[] = [];
  for (const payload of payloads) {
    offsets.push(cursor);
    bytes.push(...payload);
    cursor += payload.length;
  }
  for (const offset of offsets) bytes.push(...ref(offset, offsetSize));
  bytes.push(0, 0, 0, 0, 0, 0, offsetSize, refSize);
  bytes.push(...ref(objectCount, 8), ...ref(0, 8), ...ref(cursor, 8));
  return new Uint8Array(bytes);
}

/** Reads a document, reporting its value, or the reason or error name that refused it. */
function outcomeOf(bytes: Uint8Array): string {
  try {
    return JSON.stringify(parseApplePlist(bytes))!;
  } catch (error) {
    return error instanceof ApplePlistParseError
      ? error.reason
      : `untyped:${(error as Error).name}`;
  }
}

const malformed = APPLE_PLIST_PARSE_REASONS.malformed.reason;

/**
 * Nesting is bounded the same way in both stored forms: a document a real writer could have produced is
 * read, and a deeper one is refused as malformed rather than running the binary reader out of stack.
 */
for (const [depth, expected] of [
  [200, 'value'],
  [300, malformed],
  [5_000, malformed],
] as const) {
  test(`values nested ${depth} levels deep answer as a ${expected === 'value' ? 'value' : 'refusal'} in both forms`, () => {
    const xml = outcomeOf(nestedDictXml(depth));
    const binary = outcomeOf(nestedDictBinary(depth));
    assert.equal(binary, xml);
    if (expected === 'value') assert.match(xml, /"k":true/);
    else assert.equal(xml, malformed);
  });
}

const malformedCases = [
  [
    'a binary object reference naming an index past the object count',
    binaryDocument('YnBsaXN0MDChAlFBCAoAAAAAAAABAQAAAAAAAAACAAAAAAAAAAAAAAAAAAAADA=='),
  ],
  ['an XML document whose tag is left open', new TextEncoder().encode('<plist><dict><key>A</key>')],
  [
    'an XML <dict> entry that does not start with a <key>',
    xmlDocument('<key>A</key><string>a</string><integer>1</integer>'),
  ],
  ['an XML <data> that is not base64', xmlDocument('<key>A</key><data>not base64!!</data>')],
  ['an XML <integer> with no number in it', xmlDocument('<key>A</key><integer>abc</integer>')],
  [
    'an XML <integer> whose text is a number followed by other text',
    xmlDocument('<key>A</key><integer>12abc</integer>'),
  ],
  [
    'an XML <integer> beyond the largest integer a JS number holds exactly',
    xmlDocument('<key>A</key><integer>9007199254740993</integer>'),
  ],
  [
    'an XML <real> whose text is a number followed by a unit suffix',
    xmlDocument('<key>A</key><real>3.5f</real>'),
  ],
  ['an XML <real> holding two decimal points', xmlDocument('<key>A</key><real>1.5.5</real>')],
  [
    'a document shorter than a binary header and trailer',
    new TextEncoder().encode('bplist00 truncated'),
  ],
  [
    'a binary document whose top object index is past its object count',
    binaryDocument('YnBsaXN0MDAJCAAAAAAAAAEBAAAAAAAAAAEAAAAAAAAABAAAAAAAAAAJ'),
  ],
  [
    'a binary document whose object contains itself',
    binaryDocument('YnBsaXN0MDDRAAAIAAAAAAAAAQEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAs='),
  ],
  [
    'a binary string whose length runs past the document',
    binaryDocument('YnBsaXN0MDBfEchBCAAAAAAAAAEBAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAM'),
  ],
  ['a text document that is not a plist at all', new TextEncoder().encode('{ key = value; }')],
] as const;

for (const [label, bytes] of malformedCases) {
  test(`${label} is refused as malformed`, () => {
    assert.throws(
      () => parseApplePlist(bytes),
      refusedWith(APPLE_PLIST_PARSE_REASONS.malformed.reason),
    );
  });
}

const unsupportedCases = [
  ['an XML tag this reader does not model', xmlDocument('<key>A</key><openstep/>')],
  [
    'a binary object kind this reader does not model',
    binaryDocument('YnBsaXN0MDBwCAAAAAAAAAEBAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAJ'),
  ],
] as const;

for (const [label, bytes] of unsupportedCases) {
  test(`${label} is refused as an unsupported type`, () => {
    assert.throws(
      () => parseApplePlist(bytes),
      refusedWith(APPLE_PLIST_PARSE_REASONS.unsupportedType.reason),
    );
  });
}

for (const [label, document] of [
  ['an array', '<plist><array><string>a</string></array></plist>'],
  ['a scalar', '<plist><string>scalar</string></plist>'],
] as const) {
  test(`a plist whose root value is ${label} is read as no metadata`, () => {
    assert.equal(parseApplePlist(new TextEncoder().encode(document)), null);
  });
}
