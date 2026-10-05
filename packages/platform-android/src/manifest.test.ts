import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { beforeEach, test } from 'vitest';
import { bindAndroidAdbHostStub } from './adb-host.fixtures.ts';
import { mkdtempForTest } from './__tests__/test-utils/tmp-dir.ts';
import { resolveAndroidArchivePackageName } from './manifest.ts';
import {
  ANDROID_MANIFEST_BINARY_FIXTURE_PATH,
  ANDROID_MANIFEST_APK_FIXTURE_PATH,
  ANDROID_MANIFEST_FIXTURE_PACKAGE,
  RES_STRING_POOL_TYPE,
  RES_XML_ATTR_EXT_SIZE,
  RES_XML_ATTRIBUTE_SIZE,
  RES_XML_NODE_HEADER_SIZE,
  RES_XML_START_ELEMENT_TYPE,
  buildBinaryAndroidManifest,
  buildStoredZipArchive,
  listBinaryManifestChunks,
  type BinaryManifestChunk,
  type SyntheticManifest,
} from './manifest.fixtures.ts';

// Same budget as the canonical selectors fixture count, which platform packages may not import (R13).
const PROPERTY_RUNS = 100;
const PKG = ANDROID_MANIFEST_FIXTURE_PACKAGE;
const binaryManifestFixture = readFileSync(ANDROID_MANIFEST_BINARY_FIXTURE_PATH);

beforeEach(() => bindAndroidAdbHostStub());

let archivePath: Promise<string> | undefined;

// Resolves through the product seam: the manifest travels in a ZIP, so the same `unzip`
// extraction, entry candidates, and `aapt` fallback the daemon runs are exercised. The adb-host
// stub answers `isExecutable` as false, so identity can only come from the binary manifest.
async function resolveManifest(
  manifest: Buffer,
  entry = 'AndroidManifest.xml',
): Promise<string | undefined> {
  archivePath ??= mkdtempForTest('agent-device-android-manifest-').then((dir) =>
    path.join(dir, 'app.apk'),
  );
  const file = await archivePath;
  await fs.writeFile(file, buildStoredZipArchive(new Map([[entry, manifest]])));
  return await resolveAndroidArchivePackageName(file);
}

function chunkByType(manifest: Buffer, type: number): BinaryManifestChunk {
  const chunk = listBinaryManifestChunks(manifest).find((candidate) => candidate.type === type);
  assert.ok(chunk, `fixture carries a chunk of type ${type.toString(16)}`);
  return chunk;
}

const attr = (name: string, value: string) => ({ name, value });

// One row per shape a real toolchain emits or a corrupt producer might emit, carrying the
// outcome the AOSP rule requires. Removing a guard fails exactly the rows that name it.
const SYNTHETIC_CASES: readonly [string, SyntheticManifest, string | undefined, string?][] = [
  // AOSP whole-array bound: records sit physically after a chunk that declares one fewer.
  ['an attribute array declared past its chunk', { startElementChunkSizeShrink: 20 }, undefined],
  // Stride guard: two 16-byte records fit the chunk, so only the stride rule realigns the read.
  [
    'an attribute stride below one ResXMLTree_attribute',
    { attributeStride: RES_XML_ATTRIBUTE_SIZE - 4, attributes: [attr('versionCode', '7')] },
    undefined,
  ],
  [
    'a node header smaller than ResXMLTree_node',
    { nodeHeaderSize: RES_XML_NODE_HEADER_SIZE - 4 },
    undefined,
  ],
  // Chunk-size guard: valid node header, records present; the chunk denies the attrExt room.
  [
    'a node chunk with no room for ResXMLTree_attrExt',
    { startElementChunkSizeShrink: 24 },
    undefined,
  ],
  // Overlap guard: at attributeStart 0 the array fits, and record 1 lands on the package record.
  [
    'an attribute array overlapping ResXMLTree_attrExt',
    { attributeStartOverride: 0, attributes: [attr('versionCode', '7')] },
    undefined,
  ],
  [
    'a package on a non-manifest element',
    { packageName: PKG, elementName: 'application' },
    undefined,
  ],
  [
    'the typed value alone',
    { packageName: 'com.example.tv', typedValueOnly: true },
    'com.example.tv',
  ],
  [
    'a UTF-8 string pool',
    { packageName: 'com.example.utf8', utf8Strings: true },
    'com.example.utf8',
  ],
  // The `package` attribute genuinely last, behind two other attributes.
  [
    'the package behind other manifest attributes',
    {
      packageName: 'com.example.behind',
      packagePosition: 'last',
      attributes: [attr('versionCode', '7'), attr('versionName', '1.2.3')],
    },
    'com.example.behind',
  ],
  // Valid control for the refusals: an extended attrExt and stride must parse, not be refused.
  [
    'an extended attrExt and stride',
    {
      packageName: 'com.example.wide',
      attrExtSize: RES_XML_ATTR_EXT_SIZE + 8,
      attributeStride: RES_XML_ATTRIBUTE_SIZE + 4,
      attributes: [attr('versionCode', '7')],
    },
    'com.example.wide',
  ],
  // The resolver's second entry candidate. A real `.aab` carries a protobuf manifest there and
  // resolves to undefined; this proves the candidate itself still parses a binary XML manifest.
  [
    'a bundle layout',
    { packageName: 'com.example.bundle', utf8Strings: true },
    'com.example.bundle',
    'base/manifest/AndroidManifest.xml',
  ],
];

for (const [shape, input, expected, entry] of SYNTHETIC_CASES) {
  const outcome = expected === undefined ? 'refuses' : 'reads';
  test(`resolveAndroidArchivePackageName ${outcome} a synthetic manifest with ${shape}`, async () => {
    assert.equal(await resolveManifest(buildBinaryAndroidManifest(input), entry), expected);
  });
}

// Mutations of the committed aapt2-built manifest that every AOSP rule must refuse. A zero-size
// chunk would strand the walk forever, so termination depends on `validate_chunk` refusing it.
const write16 =
  (value: number, at: (p: BinaryManifestChunk) => number) => (m: Buffer, p: BinaryManifestChunk) =>
    m.writeUInt16LE(value, at(p));
const write32 =
  (value: number, at: (p: BinaryManifestChunk) => number) => (m: Buffer, p: BinaryManifestChunk) =>
    m.writeUInt32LE(value, at(p));

const FIXTURE_REFUSALS: readonly [string, (manifest: Buffer, pool: BinaryManifestChunk) => void][] =
  [
    ['its declared tree size shrunk to the header', write32(8, () => 4)],
    ['a pool headerSize of 0', write16(0, (p) => p.offset + 2)],
    ['a pool headerSize of 29', write16(29, (p) => p.offset + 2)],
    ['a pool chunkSize of 0', write32(0, (p) => p.offset + 4)],
    // stringCount 0xffffffff claims a table larger than any pool; AOSP refuses the pool outright.
    ['a pool stringCount of 0xffffffff', write32(0xffffffff, () => 8 + 8)],
    // The committed `<manifest>` declares 7 records; 65535 must fail the declared-array bound.
    [
      'an attribute count of 65535',
      (m) => {
        const node = chunkByType(m, RES_XML_START_ELEMENT_TYPE);
        m.writeUInt16LE(0xffff, node.offset + node.headerSize + 12);
      },
    ],
    // Offsets past the pool must refuse each string individually: an escaping error would
    // prevent the `aapt` fallback entirely.
    [
      'an unreadable string pool',
      (m, pool) => {
        const stringCount = m.readUInt32LE(pool.offset + 8);
        assert.ok(stringCount > 0);
        for (let index = 0; index < stringCount; index += 1) {
          m.writeUInt32LE(pool.chunkSize * 2, pool.offset + pool.headerSize + index * 4);
        }
      },
    ],
  ];

for (const [corruption, mutate] of FIXTURE_REFUSALS) {
  test(`resolveAndroidArchivePackageName refuses a manifest with ${corruption}`, async () => {
    const manifest = Buffer.from(binaryManifestFixture);
    mutate(manifest, chunkByType(manifest, RES_STRING_POOL_TYPE));
    assert.equal(await resolveManifest(manifest), undefined);
  });
}

test('resolveAndroidArchivePackageName reads the package from an aapt2-built APK without aapt', async () => {
  // The #3176 reinstall case: the package inventory yields nothing, so only the artifact's
  // binary manifest can name the app.
  assert.equal(await resolveAndroidArchivePackageName(ANDROID_MANIFEST_APK_FIXTURE_PATH), PKG);
});

test('resolveAndroidArchivePackageName reads a committed aapt2-built manifest from a ZIP', async () => {
  assert.equal(await resolveManifest(binaryManifestFixture), PKG);
});

test('resolveAndroidArchivePackageName reads a pool whose offset table follows an extended header', async () => {
  // AOSP derives the offset table from `chunk + headerSize`; four header-extension bytes must
  // not move the strings, and `aapt dump badging` reports the package for this shape.
  const pool = chunkByType(binaryManifestFixture, RES_STRING_POOL_TYPE);
  const extended = Buffer.alloc(binaryManifestFixture.length + 4);
  binaryManifestFixture.copy(extended, 0, 0, pool.offset + pool.headerSize);
  binaryManifestFixture.copy(
    extended,
    pool.offset + pool.headerSize + 4,
    pool.offset + pool.headerSize,
  );
  extended.writeUInt32LE(binaryManifestFixture.readUInt32LE(4) + 4, 4);
  extended.writeUInt16LE(pool.headerSize + 4, pool.offset + 2);
  extended.writeUInt32LE(pool.chunkSize + 4, pool.offset + 4);
  extended.writeUInt32LE(
    binaryManifestFixture.readUInt32LE(pool.offset + 20) + 4,
    pool.offset + 20,
  );
  assert.equal(await resolveManifest(extended), PKG);
});

test('resolveAndroidArchivePackageName refuses a manifest truncated through the package attribute record', async () => {
  // Cut one byte before the start-element's end, through the last (package) record, and
  // re-declare the tree and node sizes: only the whole-array bound refuses it.
  const manifest = buildBinaryAndroidManifest({
    packagePosition: 'last',
    attributes: [attr('versionCode', '7')],
  });
  const node = chunkByType(manifest, RES_XML_START_ELEMENT_TYPE);
  const truncated = Buffer.from(manifest.subarray(0, node.offset + node.chunkSize - 1));
  truncated.writeUInt32LE(truncated.length, 4);
  const surviving = truncated.length - node.offset;
  truncated.writeUInt32LE(surviving - (surviving % 4), node.offset + 4);
  assert.equal(await resolveManifest(truncated), undefined);
});

test('resolveAndroidArchivePackageName reads a text manifest', async () => {
  const text =
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.text" />';
  assert.equal(await resolveManifest(Buffer.from(text, 'utf8')), 'com.example.text');
});

test('resolveAndroidArchivePackageName refuses bytes that are not a ResXMLTree', async () => {
  assert.equal(await resolveManifest(Buffer.from('not a manifest')), undefined);
});

// Every shape a valid aapt2 manifest may take: package position, extended attrExt/stride,
// UTF-8 or UTF-16 pools, raw or typed values, and padding strings that shift pool indices.
const SHAPE_ARBITRARY = fc.record({
  packageName: fc.stringMatching(/^[a-z][a-z0-9]{0,7}(\.[a-z][a-z0-9]{0,7}){1,3}$/),
  attributes: fc.array(
    fc.record({
      name: fc.stringMatching(/^attr[0-9a-z]{1,6}$/),
      value: fc.stringMatching(/^[0-9a-z]{1,12}$/),
    }),
    { maxLength: 4 },
  ),
  // 0 lands first; 4 clamps past the end, which is `last`.
  packagePosition: fc.integer({ min: 0, max: 4 }),
  attrExtSize: fc.constantFrom(RES_XML_ATTR_EXT_SIZE, RES_XML_ATTR_EXT_SIZE + 8),
  attributeStride: fc.constantFrom(RES_XML_ATTRIBUTE_SIZE, RES_XML_ATTRIBUTE_SIZE + 4),
  utf8Strings: fc.boolean(),
  typedValueOnly: fc.boolean(),
  paddingStrings: fc.nat({ max: 24 }),
});

test('resolveAndroidArchivePackageName recovers the package for every well-formed manifest shape', async () => {
  await fc.assert(
    fc.asyncProperty(SHAPE_ARBITRARY, async (shape) => {
      assert.equal(await resolveManifest(buildBinaryAndroidManifest(shape)), shape.packageName);
    }),
    { numRuns: PROPERTY_RUNS },
  );
});

test('resolveAndroidArchivePackageName never throws on corrupt manifest bytes, so the aapt fallback stays reachable', async () => {
  // The resolver calls the binary parser without catching, so every corrupt shape must refuse
  // or answer — never escape as an exception past the documented `aapt` fallback.
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.record({
          index: fc.integer({ min: 0, max: binaryManifestFixture.length - 1 }),
          value: fc.integer({ min: 0, max: 255 }),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      async (patches) => {
        const manifest = Buffer.from(binaryManifestFixture);
        for (const patch of patches) manifest[patch.index] = patch.value;
        await resolveManifest(manifest);
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});
