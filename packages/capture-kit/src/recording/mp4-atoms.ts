import fs from 'node:fs';

// Bounded so a corrupt container cannot widen the walk; a movie header past the budget simply
// reads as absent.
const MAX_SIBLINGS_PER_LEVEL = 32;
const ATOM_HEADER_BYTES = 8;
const EXTENDED_SIZE_BYTES = 8;

export type Mp4Atom = Readonly<{
  /** Four-character box type, for example `moov`. */
  type: string;
  /** Byte offset where the box header starts. */
  offset: number;
  headerSize: number;
  /** Total box size in bytes, including the header. */
  size: number;
}>;

/** Locates a box by its ancestor-to-leaf type path, for example `['moov', 'mvhd']`. */
export function findMp4Atom(filePath: string, names: readonly string[]): Mp4Atom | undefined {
  if (names.length === 0) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const root: Mp4Atom = { type: '', offset: 0, headerSize: 0, size: fs.fstatSync(fd).size };
    return findDescendant(fd, root, names, 0);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function findDescendant(
  fd: number,
  container: Mp4Atom,
  names: readonly string[],
  depth: number,
): Mp4Atom | undefined {
  for (const atom of childAtoms(fd, container)) {
    if (atom.type !== names[depth]) continue;
    if (depth + 1 === names.length) return atom;
    const match = findDescendant(fd, atom, names, depth + 1);
    if (match) return match;
  }
  return undefined;
}

function* childAtoms(fd: number, container: Mp4Atom): Generator<Mp4Atom> {
  const end = container.offset + container.size;
  let offset = container.offset + container.headerSize;
  for (
    let seen = 0;
    offset + ATOM_HEADER_BYTES <= end && seen < MAX_SIBLINGS_PER_LEVEL;
    seen += 1
  ) {
    const atom = readAtomHeader(fd, offset, end);
    if (!atom) return;
    yield atom;
    // A box that claims more room than its container holds, or an unrepresentable 64-bit size,
    // ends this level: nothing past it can be located.
    if (
      !Number.isSafeInteger(atom.size) ||
      atom.size < atom.headerSize ||
      atom.offset + atom.size > end
    )
      return;
    offset += atom.size;
  }
}

function readAtomHeader(fd: number, offset: number, end: number): Mp4Atom | undefined {
  const header = readBytes(fd, offset, ATOM_HEADER_BYTES);
  if (!header) return undefined;
  let size = header.readUInt32BE(0);
  let headerSize = ATOM_HEADER_BYTES;
  if (size === 1) {
    const extended = readBytes(fd, offset + ATOM_HEADER_BYTES, EXTENDED_SIZE_BYTES);
    if (!extended) return undefined;
    size = Number(extended.readBigUInt64BE(0));
    headerSize += EXTENDED_SIZE_BYTES;
  }
  // A declared size of 0 means the box runs to the end of its container.
  return {
    type: header.toString('latin1', 4, 8),
    offset,
    headerSize,
    size: size === 0 ? end - offset : size,
  };
}

function readBytes(fd: number, offset: number, length: number): Buffer | undefined {
  const buffer = Buffer.alloc(length);
  try {
    return fs.readSync(fd, buffer, 0, length, offset) === length ? buffer : undefined;
  } catch {
    return undefined;
  }
}
