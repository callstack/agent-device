import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishFileSync } from '../utils/atomic-file.ts';
import {
  buildDaemonCodeFileLabel,
  formatDaemonCodeSignature,
  walkDaemonCodeGraph,
  type DaemonCodeFileStamp,
} from './code-signature.ts';

// Bump when the stored shape changes; old documents then miss instead of
// parsing wrong. Only this module needs the guard: `code-signature.ts` is
// itself inside the graph it walks, so changing the WALK invalidates every
// document through the ordinary stamp comparison.
const CACHE_FORMAT_VERSION = 1;
// Per-user, and readable only by that user: `os.tmpdir()` is per-user on
// macOS but the shared `/tmp` on Linux, where a single directory would mean
// whichever uid ran first owns it and every other uid's publish fails EACCES
// forever, silently — and where a document any local process could write
// would choose the signature this client compares a running daemon against.
const CACHE_DIRECTORY_PREFIX = 'agent-device-code-signature';
const CACHE_DIRECTORY_MODE = 0o700;
const CACHE_DOCUMENT_MODE = 0o600;

type CacheDocument = {
  version: typeof CACHE_FORMAT_VERSION;
  files: DaemonCodeFileStamp[];
};

/**
 * The daemon code signature for a SOURCE checkout, where the import graph is
 * ~800 separate modules rather than a bundle. The client fingerprints that
 * graph on every CLI invocation (`isReusableDaemonInfo`), and rediscovering
 * its edges means reading all ~800 files: ~30ms of a ~245ms invocation, for a
 * graph that is identical on every invocation but the first one after an edit.
 *
 * So the walk is cached and revalidated by `statSync` alone. For an edit to a
 * file ALREADY in the graph that is exactly as strong as the walk it
 * replaces: the signature itself treats a file's `size:mtime` as the stand-in
 * for its contents (`DaemonCodeFileStamp`), so a still-matching pair means an
 * unchanged file, therefore an unchanged specifier list, therefore an
 * unchanged graph. It is deliberately weaker in one direction, because the
 * set of files to revalidate is read out of the document: a module that JOINS
 * the graph without touching any recorded file — an import whose target did
 * not exist when the document was published and is created afterwards — stays
 * invisible until some recorded file changes. The cost is a source-checkout
 * dev loop reusing a daemon one edit stale; the next edit to any graph file
 * republishes.
 *
 * Any mismatched, vanished, or newly non-file entry, and any unreadable,
 * malformed, foreign, or entry-less cache document, falls back to the full
 * walk, which republishes. The cache is a best-effort artifact under
 * `os.tmpdir()`, like the Swift toolchain cache: failing to read or write one
 * only costs the walk.
 */
export function resolveCachedDaemonCodeSignature(entryPath: string, root: string): string {
  const cachePath = resolveCachePath(entryPath, root);
  const entryLabel = buildDaemonCodeFileLabel(root, entryPath);
  const validated = readValidatedStamps(cachePath, root, entryLabel);
  if (validated) return formatDaemonCodeSignature(validated);

  let stamps: DaemonCodeFileStamp[];
  try {
    stamps = walkDaemonCodeGraph(entryPath, root);
  } catch {
    return 'unknown';
  }
  if (describesEntry(stamps, entryLabel)) publishStamps(cachePath, stamps);
  return formatDaemonCodeSignature(stamps);
}

/** The recorded stamps when every one of them still describes the file on disk. */
function readValidatedStamps(
  cachePath: string,
  root: string,
  entryLabel: string,
): DaemonCodeFileStamp[] | undefined {
  const stamps = readCachedStamps(cachePath);
  if (!stamps || !describesEntry(stamps, entryLabel)) return undefined;
  for (const [label, size, mtimeMs] of stamps) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(path.resolve(root, label));
    } catch {
      return undefined;
    }
    if (!stat.isFile() || stat.size !== size || Math.trunc(stat.mtimeMs) !== mtimeMs) {
      return undefined;
    }
  }
  return stamps;
}

/**
 * Whether a stamp list can be this entry's graph at all. The walk always
 * stamps the entry itself, so a list without it is foreign or truncated — and
 * the empty list is the dangerous shape: every stamp in it matches vacuously,
 * so it would validate forever, and a signature no daemon reports restarts a
 * healthy daemon on every invocation. Publishing is gated on the same
 * question, so a document this reader would refuse is never written.
 */
function describesEntry(stamps: readonly DaemonCodeFileStamp[], entryLabel: string): boolean {
  return stamps.some(([label]) => label === entryLabel);
}

function readCachedStamps(cachePath: string): DaemonCodeFileStamp[] | undefined {
  const entries = readCachedEntries(cachePath);
  if (!entries) return undefined;
  const stamps: DaemonCodeFileStamp[] = [];
  for (const entry of entries) {
    const stamp = readStamp(entry);
    if (!stamp) return undefined;
    stamps.push(stamp);
  }
  return stamps;
}

/** The document's raw entries, or `undefined` for anything this format cannot own. */
function readCachedEntries(cachePath: string): unknown[] | undefined {
  const contents = readOwnedDocument(cachePath);
  if (contents === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const document = parsed as Partial<CacheDocument>;
  if (document.version !== CACHE_FORMAT_VERSION) return undefined;
  return Array.isArray(document.files) ? document.files : undefined;
}

/** The document's text, but only when this user is the one who wrote it. */
function readOwnedDocument(cachePath: string): string | undefined {
  let handle: number;
  try {
    handle = fs.openSync(cachePath, 'r');
  } catch {
    return undefined;
  }
  try {
    // The ownership check and the read share one descriptor, so what is
    // trusted is what is read. Where uids do not exist the temporary
    // directory is per-user by construction and there is nothing to check.
    const userId = process.getuid?.();
    if (userId !== undefined && fs.fstatSync(handle).uid !== userId) return undefined;
    return fs.readFileSync(handle, 'utf8');
  } catch {
    return undefined;
  } finally {
    fs.closeSync(handle);
  }
}

function readStamp(entry: unknown): DaemonCodeFileStamp | undefined {
  if (!Array.isArray(entry) || entry.length !== 3) return undefined;
  const [label, size, mtimeMs] = entry as unknown[];
  if (typeof label !== 'string' || typeof size !== 'number' || typeof mtimeMs !== 'number') {
    return undefined;
  }
  return [label, size, mtimeMs];
}

function publishStamps(cachePath: string, files: DaemonCodeFileStamp[]): void {
  const document: CacheDocument = { version: CACHE_FORMAT_VERSION, files };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: CACHE_DIRECTORY_MODE });
    publishFileSync({
      destination: cachePath,
      contents: JSON.stringify(document),
      mode: CACHE_DOCUMENT_MODE,
    });
  } catch {
    // Best effort: an uncached signature is still a correct signature.
  }
}

/** One document per (entry, root) pair, so sibling checkouts never share one. */
function resolveCachePath(entryPath: string, root: string): string {
  const key = crypto
    .createHash('sha1')
    .update(`${resolveRealPath(root)} ${resolveRealPath(entryPath)}`)
    .digest('hex');
  const directory = `${CACHE_DIRECTORY_PREFIX}-${process.getuid?.() ?? 'user'}`;
  return path.join(os.tmpdir(), directory, `${key}.json`);
}

/** Symlinked paths to one checkout are one checkout, as in `buildSourceCheckoutStateDirName`. */
function resolveRealPath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}
