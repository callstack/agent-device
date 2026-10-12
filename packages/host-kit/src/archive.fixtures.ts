import { promises as fs } from 'node:fs';

import path from 'node:path';
import { crc32, gzipSync } from 'node:zlib';
import * as tar from 'tar-stream';
import { mkdtempForTest } from './internal/tmp-dir.fixtures.ts';

export async function createArchiveWorkspace(): Promise<{
  archivePath: string;
  outputRoot: string;
  root: string;
}> {
  const root = await mkdtempForTest('agent-device-archive-');
  const outputRoot = path.join(root, 'output');
  await fs.mkdir(outputRoot);
  return { archivePath: path.join(root, 'fixture.archive'), outputRoot, root };
}

export async function createTruncatedTgz(archivePath: string): Promise<void> {
  const pack = tar.pack();
  pack.entry({ name: 'payload.bin' }, Buffer.from('AB'));
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const headerOnly = Buffer.concat(chunks).subarray(0, 512);
  await fs.writeFile(archivePath, gzipSync(headerOnly));
}

/** Two stored entries whose second carries the encrypted general-purpose flag bit. */
export async function createZipWithEncryptedSecondEntry(archivePath: string): Promise<void> {
  await writeZipFixture(archivePath, [
    { name: 'first.txt', mode: ZIP_FILE_MODE, data: 'first' },
    { name: 'second.txt', mode: ZIP_FILE_MODE, data: 'second', encrypted: true },
  ]);
}

const ZIP_FILE_MODE = 0o100644;

/** One stored zip entry; `mode` is the full Unix `st_mode`, file-type bits included. */
export type ZipFixtureEntry = {
  name: string;
  mode: number;
  data?: string;
  /** Declares the entry encrypted, which no archive reader may then extract. */
  encrypted?: boolean;
};

/**
 * Writes a stored (uncompressed) zip whose names and Unix attributes are exactly as given, which
 * `zip` itself refuses to produce for links, special files, and escaping names. An entry declared
 * `encrypted` carries the traditional encryption flag with a padded 12-byte encryption header and
 * a zero CRC, the shape readers must refuse before extracting anything.
 */
export async function writeZipFixture(
  archivePath: string,
  entries: readonly ZipFixtureEntry[],
): Promise<void> {
  const localRecords: Buffer[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = Buffer.from(entry.data ?? '', 'utf8');
    // A traditionally encrypted stored entry carries a 12-byte encryption header before the
    // ciphertext, and readers validate that against the declared sizes, so the record declares
    // it and the data section pads it; the payload itself never decrypts to anything.
    const data = entry.encrypted ? Buffer.concat([Buffer.alloc(12), payload]) : payload;
    const checksum = entry.encrypted ? 0 : crc32(payload);
    const flags = 0x0800 | (entry.encrypted ? 0x0001 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(payload.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, name, data);
    centralRecords.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  await fs.writeFile(archivePath, Buffer.concat([...localRecords, centralDirectory, end]));
}

/** `pax` records are written as a PAX extended header; tar-stream's typings omit the field. */
export type TarFixtureEntry = {
  header: tar.Headers;
  pax?: Record<string, string>;
  data?: string;
};

export async function writeTarFixture(
  archivePath: string,
  entries: readonly TarFixtureEntry[],
): Promise<void> {
  const pack = tar.pack();
  const zeroModeEntries = new Set<number>();
  entries.forEach((entry, index) => {
    if (entry.header.mode === 0) zeroModeEntries.add(index);
    const header: tar.Headers & { pax?: Record<string, string> } = entry.pax
      ? { ...entry.header, pax: entry.pax }
      : { ...entry.header };
    pack.entry(header, Buffer.from(entry.data ?? ''));
  });
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const chunk of pack) chunks.push(Buffer.from(chunk));
  const archive = Buffer.concat(chunks);
  restoreZeroTarModes(archive, zeroModeEntries);
  await fs.writeFile(archivePath, archive);
}

const TAR_BLOCK = 512;
const PAX_TYPEFLAGS = new Set(['x', 'g']);

/**
 * tar-stream's pack replaces a zero mode with its default, so a declared zero is written back into
 * the emitted ustar header, checksum included. Entries are matched by emitted order; the PAX
 * extended header tar-stream emits before an entry is not counted.
 */
function restoreZeroTarModes(archive: Buffer, zeroModeEntries: ReadonlySet<number>): void {
  if (zeroModeEntries.size === 0) return;
  let entryIndex = 0;
  for (let offset = 0; offset + TAR_BLOCK <= archive.length;) {
    const block = archive.subarray(offset, offset + TAR_BLOCK);
    if (block.every((byte) => byte === 0)) return;
    if (!PAX_TYPEFLAGS.has(String.fromCharCode(block[156]!))) {
      if (zeroModeEntries.has(entryIndex)) {
        block.write('000000 ', 100, 'ascii');
        block.write(`${tarChecksum(block).toString(8).padStart(6, '0')} `, 148, 'ascii');
      }
      entryIndex += 1;
    }
    const size = Number.parseInt(block.toString('ascii', 124, 136).split('\0')[0]!, 8) || 0;
    offset += TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
}

function tarChecksum(block: Buffer): number {
  let sum = 8 * 0x20;
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    if (index < 148 || index >= 156) sum += block[index]!;
  }
  return sum;
}
