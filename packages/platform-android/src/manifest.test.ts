import assert from 'node:assert/strict';
import { promises as fs, readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, test } from 'vitest';
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
} from './manifest.fixtures.ts';

// Same budget as the canonical `@agent-device/selectors/snapshot-geometry-fixtures` count; the
// subpath is off-limits to platform packages (R13), and this file's two properties together stay
// inside the unit slow-test budget it exists to protect.
const PROPERTY_RUNS = 100;

const binaryManifestFixture = readFileSync(ANDROID_MANIFEST_BINARY_FIXTURE_PATH);

beforeEach(() => {
  bindAndroidAdbHostStub();
});
afterEach(() => {
  bindAndroidAdbHostStub();
});

let archivePath: Promise<string> | undefined;
function archiveFilePath(): Promise<string> {
  archivePath ??= mkdtempForTest('agent-device-android-manifest-').then((dir) =>
    path.join(dir, 'app.apk'),
  );
  return archivePath;
}

/**
 * Resolves through the product seam: the manifest is stored in a ZIP so the same
 * `unzip` extraction, entry candidates, and `aapt` fallback the daemon runs are exercised.
 * The adb-host stub answers `isExecutable` as false, so no `aapt` is reachable and an
 * identity can only come from the binary manifest.
 */
async function resolveManifest(
  manifest: Buffer,
  entry = 'AndroidManifest.xml',
): Promise<string | undefined> {
  const file = await archiveFilePath();
  await fs.writeFile(file, buildStoredZipArchive(new Map([[entry, manifest]])));
  return await resolveAndroidArchivePackageName(file);
}

function firstStartElement(manifest: Buffer) {
  const chunk = listBinaryManifestChunks(manifest).find(
    (candidate) => candidate.type === RES_XML_START_ELEMENT_TYPE,
  );
  assert.ok(chunk, 'fixture carries a start-element chunk');
  return chunk;
}

test('resolveAndroidArchivePackageName reads the package from an aapt2-built APK without aapt', async () => {
  // The already-installed reinstall case from #3176: the before/after package inventory yields
  // nothing, so the artifact's binary manifest is the only identity source.
  assert.equal(
    await resolveAndroidArchivePackageName(ANDROID_MANIFEST_APK_FIXTURE_PATH),
    ANDROID_MANIFEST_FIXTURE_PACKAGE,
  );
});

test('resolveAndroidArchivePackageName reads a committed aapt2-built manifest from a ZIP', async () => {
  assert.equal(await resolveManifest(binaryManifestFixture), ANDROID_MANIFEST_FIXTURE_PACKAGE);
});

test('resolveAndroidArchivePackageName reads the package through the typed value alone', async () => {
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({
        packageName: 'com.example.typedvalue',
        typedValueOnly: true,
      }),
    ),
    'com.example.typedvalue',
  );
});

test('resolveAndroidArchivePackageName reads a UTF-8 string pool', async () => {
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({ packageName: 'com.example.utf8', utf8Strings: true }),
    ),
    'com.example.utf8',
  );
});

test('resolveAndroidArchivePackageName finds the package behind other manifest attributes', async () => {
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({
        packageName: 'com.example.behind',
        packagePosition: 'last',
        attributes: [
          { name: 'versionCode', value: '7' },
          { name: 'versionName', value: '1.2.3' },
        ],
      }),
    ),
    'com.example.behind',
  );
});

test('resolveAndroidArchivePackageName parses a manifest whose attribute array uses an extended attrExt and stride', async () => {
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({
        packageName: 'com.example.wide',
        attrExtSize: RES_XML_ATTR_EXT_SIZE + 8,
        attributeStride: RES_XML_ATTRIBUTE_SIZE + 4,
        attributes: [{ name: 'versionCode', value: '7' }],
      }),
    ),
    'com.example.wide',
  );
});

test('resolveAndroidArchivePackageName reads a text manifest', async () => {
  const text = Buffer.from(
    '<?xml version="1.0"?><manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.text" />',
    'utf8',
  );
  assert.equal(await resolveManifest(text), 'com.example.text');
});

test('resolveAndroidArchivePackageName ignores a package on a non-manifest element', async () => {
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({
        packageName: ANDROID_MANIFEST_FIXTURE_PACKAGE,
        elementName: 'application',
      }),
    ),
    undefined,
  );
});

test('resolveAndroidArchivePackageName refuses an attribute array declared past its chunk', async () => {
  // The node declares a chunk one attribute record shorter while the record bytes stay
  // physically present after it, so only the AOSP whole-array bound can refuse the node;
  // bounding reads by the buffer length would read the package out of those leftover bytes.
  assert.equal(
    await resolveManifest(buildBinaryAndroidManifest({ startElementChunkSizeShrink: 20 })),
    undefined,
  );
});

test('resolveAndroidArchivePackageName refuses an attribute stride below one ResXMLTree_attribute', async () => {
  // With two 16-byte records the declared array fits inside the chunk, so only the stride
  // guard can stop the parser — without it the package record reads at the wrong offset.
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({
        attributeStride: RES_XML_ATTRIBUTE_SIZE - 4,
        attributes: [{ name: 'versionCode', value: '7' }],
      }),
    ),
    undefined,
  );
});

test('resolveAndroidArchivePackageName refuses a node header smaller than ResXMLTree_node', async () => {
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({ nodeHeaderSize: RES_XML_NODE_HEADER_SIZE - 4 }),
    ),
    undefined,
  );
});

test('resolveAndroidArchivePackageName refuses a node chunk with no room for ResXMLTree_attrExt', async () => {
  // The header is a valid `ResXMLTree_node` and the record bytes are physically present; only
  // the declared chunk is too short to carry the 20-byte attribute extension, which AOSP
  // checks before reading any attribute field.
  const manifest = buildBinaryAndroidManifest({ startElementChunkSizeShrink: 20 + 4 });
  const node = firstStartElement(manifest);
  assert.ok(node.chunkSize - RES_XML_NODE_HEADER_SIZE < RES_XML_ATTR_EXT_SIZE);
  assert.equal(await resolveManifest(manifest), undefined);
});

test('resolveAndroidArchivePackageName refuses an attribute array overlapping ResXMLTree_attrExt', async () => {
  // With `attributeStart` at 0 the declared array still fits the chunk, so only the AOSP
  // extension-overlap refusal stops the node; record 1 lands on the real package record and
  // would otherwise resolve it from inside the extension.
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({
        attributeStartOverride: 0,
        attributes: [{ name: 'versionCode', value: '7' }],
      }),
    ),
    undefined,
  );
});

test('resolveAndroidArchivePackageName refuses a manifest truncated through the package attribute record', async () => {
  // Cut one byte before the end of the start-element chunk, where the last (package) record
  // lives, and re-declare the tree and node sizes for the surviving bytes. Only the
  // whole-array bound can refuse this node; per-record reads would land inside the
  // truncated record and still find the package.
  const manifest = buildBinaryAndroidManifest({
    packagePosition: 'last',
    attributes: [{ name: 'versionCode', value: '7' }],
  });
  const node = firstStartElement(manifest);
  const truncated = Buffer.from(manifest.subarray(0, node.offset + node.chunkSize - 1));
  truncated.writeUInt32LE(truncated.length, 4);
  const surviving = truncated.length - node.offset;
  truncated.writeUInt32LE(surviving - (surviving % 4), node.offset + 4);
  assert.equal(await resolveManifest(truncated), undefined);
});

test('resolveAndroidArchivePackageName refuses bytes that are not a ResXMLTree', async () => {
  assert.equal(await resolveManifest(Buffer.from('not a manifest')), undefined);
});

test('resolveAndroidArchivePackageName refuses a tree whose declared size does not fit', async () => {
  const manifest = Buffer.from(binaryManifestFixture);
  manifest.writeUInt32LE(8, 4);
  assert.equal(await resolveManifest(manifest), undefined);
});

test('resolveAndroidArchivePackageName refuses a chunk header AOSP validate_chunk rejects', async () => {
  for (const headerSize of [0, 29]) {
    const manifest = Buffer.from(binaryManifestFixture);
    const pool = listBinaryManifestChunks(manifest).find(
      (chunk) => chunk.type === RES_STRING_POOL_TYPE,
    );
    assert.ok(pool);
    manifest.writeUInt16LE(headerSize, pool.offset + 2);
    assert.equal(await resolveManifest(manifest), undefined, `headerSize ${headerSize}`);
  }
});

test('resolveAndroidArchivePackageName refuses a chunk declaring no bytes instead of looping', async () => {
  // A zero-size chunk would leave the walk at the same offset forever, so termination depends
  // on `validate_chunk` refusing it, not on a separate size sign check.
  const manifest = Buffer.from(binaryManifestFixture);
  const pool = listBinaryManifestChunks(manifest).find(
    (chunk) => chunk.type === RES_STRING_POOL_TYPE,
  );
  assert.ok(pool);
  manifest.writeUInt32LE(0, pool.offset + 4);
  assert.equal(await resolveManifest(manifest), undefined);
});

test('resolveAndroidArchivePackageName refuses a pool whose declared offset table cannot fit', async () => {
  const manifest = Buffer.from(binaryManifestFixture);
  manifest.writeUInt32LE(0xffffffff, 8 + 8);
  assert.equal(await resolveManifest(manifest), undefined);
});

test('resolveAndroidArchivePackageName refuses an attribute count whose array escapes the node', async () => {
  // The committed fixture's `<manifest>` declares 7 records; claiming 65535 must be refused
  // by validating the declared array, not by walking records until one read escapes.
  const manifest = Buffer.from(binaryManifestFixture);
  const node = firstStartElement(manifest);
  manifest.writeUInt16LE(0xffff, node.offset + node.headerSize + 12);
  assert.equal(await resolveManifest(manifest), undefined);
});

test('resolveAndroidArchivePackageName reads a pool whose offset table follows an extended header', async () => {
  // AOSP derives the offset table from `chunk + headerSize`; inserting four bytes of header
  // extension and re-declaring the sizes must not move the strings. `aapt dump badging`
  // reports the package for this shape.
  const manifest = Buffer.from(binaryManifestFixture);
  const pool = listBinaryManifestChunks(manifest).find(
    (chunk) => chunk.type === RES_STRING_POOL_TYPE,
  );
  assert.ok(pool);
  const extended = Buffer.from(manifest.subarray(pool.offset, pool.offset + pool.chunkSize));
  // Four extension bytes join the header, so the offset table begins at `chunk + headerSize`
  // instead of byte 28 and the string data moves with it.
  const rebuiltPool = Buffer.concat([
    extended.subarray(0, pool.headerSize),
    Buffer.alloc(4),
    extended.subarray(pool.headerSize),
  ]);
  rebuiltPool.writeUInt16LE(pool.headerSize + 4, 2);
  rebuiltPool.writeUInt32LE(pool.chunkSize + 4, 4);
  rebuiltPool.writeUInt32LE(extended.readUInt32LE(20) + 4, 20);
  const treeHeader = Buffer.from(manifest.subarray(0, 8));
  treeHeader.writeUInt32LE(treeHeader.readUInt32LE(4) + 4, 4);
  const extendedManifest = Buffer.concat([
    treeHeader,
    rebuiltPool,
    manifest.subarray(pool.offset + pool.chunkSize),
  ]);
  assert.equal(await resolveManifest(extendedManifest), ANDROID_MANIFEST_FIXTURE_PACKAGE);
});

test('resolveAndroidArchivePackageName refuses an unreadable string pool instead of throwing', async () => {
  // Pool offsets pointing past the pool must refuse each string individually, not abort the
  // resolver: an escaping error here would prevent the `aapt` fallback entirely.
  const manifest = Buffer.from(binaryManifestFixture);
  const pool = listBinaryManifestChunks(manifest).find(
    (chunk) => chunk.type === RES_STRING_POOL_TYPE,
  );
  assert.ok(pool);
  const stringCount = manifest.readUInt32LE(pool.offset + 8);
  assert.ok(stringCount > 0);
  for (let index = 0; index < stringCount; index += 1) {
    manifest.writeUInt32LE(pool.chunkSize * 2, pool.offset + pool.headerSize + index * 4);
  }
  assert.equal(await resolveManifest(manifest), undefined);
});

test('resolveAndroidArchivePackageName reads a bundle manifest under base/manifest', async () => {
  // The resolver's second entry candidate; the same offset rule has to hold for a bundle
  // layout. A real `.aab` carries a protobuf manifest there and resolves to undefined.
  assert.equal(
    await resolveManifest(
      buildBinaryAndroidManifest({ packageName: 'com.example.bundle', utf8Strings: true }),
      'base/manifest/AndroidManifest.xml',
    ),
    'com.example.bundle',
  );
});

test('resolveAndroidArchivePackageName recovers the package for every well-formed manifest shape', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.stringMatching(/^[a-z][a-z0-9]{0,7}(\.[a-z][a-z0-9]{0,7}){1,3}$/),
      fc.array(
        fc.record({
          name: fc.stringMatching(/^attr[0-9a-z]{1,6}$/),
          value: fc.stringMatching(/^[0-9a-z]{1,12}$/),
        }),
        { maxLength: 4 },
      ),
      fc.oneof(
        fc.constant('first' as const),
        fc.constant('last' as const),
        fc.integer({ min: 0, max: 4 }),
      ),
      fc.constantFrom(RES_XML_ATTR_EXT_SIZE, RES_XML_ATTR_EXT_SIZE + 8),
      fc.constantFrom(RES_XML_ATTRIBUTE_SIZE, RES_XML_ATTRIBUTE_SIZE + 4),
      fc.boolean(),
      fc.boolean(),
      fc.nat({ max: 24 }),
      async (
        packageName,
        attributes,
        packagePosition,
        attrExtSize,
        attributeStride,
        utf8,
        typedValueOnly,
        paddingStrings,
      ) => {
        assert.equal(
          await resolveManifest(
            buildBinaryAndroidManifest({
              packageName,
              attributes,
              packagePosition,
              attrExtSize,
              attributeStride,
              utf8Strings: utf8,
              typedValueOnly,
              paddingStrings,
            }),
          ),
          packageName,
        );
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});

test('resolveAndroidArchivePackageName never throws on corrupt manifest bytes, so the aapt fallback stays reachable', async () => {
  // The resolver calls the binary parser without catching, so any escape here prevents the
  // documented `aapt` fallback. Mutate the committed real manifest: every corrupt shape must
  // refuse or answer.
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
        // The contract is only that no case escapes as an exception: a corrupt shape must
        // either refuse or answer, never throw past the resolver into the caller.
        await resolveManifest(manifest);
      },
    ),
    { numRuns: PROPERTY_RUNS },
  );
});
