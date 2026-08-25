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
  type DaemonCodeGraphWalk,
} from './code-signature.ts';

// Bump when the stored shape changes; old documents then miss instead of
// parsing wrong. Only this module needs the guard: `code-signature.ts` is
// itself inside the graph it walks, so changing the WALK invalidates every
// document through the ordinary stamp comparison.
const CACHE_FORMAT_VERSION = 2;
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
  absent: string[];
};

/**
 * The daemon code signature for a SOURCE checkout, where the import graph is
 * ~800 separate modules rather than a bundle. The client fingerprints that
 * graph on every CLI invocation (`isReusableDaemonInfo`), and rediscovering
 * its edges means reading all ~800 files: ~30ms of a ~245ms invocation, for a
 * graph that is identical on every invocation but the first one after an edit.
 *
 * So the walk is cached and revalidated by `statSync` alone, which is exactly
 * as strong as the walk it replaces because a document records the walk's
 * whole input, not just its output. Every recorded file still matching its
 * `size:mtime` means an unchanged file — that pair is what the signature
 * already treats as the stand-in for contents (`DaemonCodeFileStamp`) —
 * therefore an unchanged specifier list; and every path in `absent` still
 * being absent means each of those specifiers still resolves where it did
 * (`DaemonCodeGraphWalk`). Unchanged specifiers resolving unchanged is an
 * unchanged graph, so re-walking could only rediscover the recorded stamps.
 *
 * Any mismatched, vanished, or newly non-file entry, any path recorded as
 * absent that now exists, and any unreadable, malformed, foreign, or
 * entry-less cache document, falls back to the full walk, which republishes.
 * The cache is a best-effort artifact under `os.tmpdir()`, like the Swift
 * toolchain cache: failing to read or write one only costs the walk.
 */
export function resolveCachedDaemonCodeSignature(entryPath: string, root: string): string {
  const cachePath = resolveCachePath(entryPath, root);
  const entryLabel = buildDaemonCodeFileLabel(root, entryPath);
  const validated = readValidatedWalk(cachePath, root, entryLabel);
  if (validated) return formatDaemonCodeSignature(validated.files);

  let walk: DaemonCodeGraphWalk;
  try {
    walk = walkDaemonCodeGraph(entryPath, root);
  } catch {
    return 'unknown';
  }
  if (describesEntry(walk.files, entryLabel)) publishWalk(cachePath, walk);
  return formatDaemonCodeSignature(walk.files);
}

/** The recorded walk when the filesystem still answers every probe the way it did. */
function readValidatedWalk(
  cachePath: string,
  root: string,
  entryLabel: string,
): DaemonCodeGraphWalk | undefined {
  const walk = readCachedWalk(cachePath);
  if (!walk || !describesEntry(walk.files, entryLabel)) return undefined;
  for (const [label, size, mtimeMs] of walk.files) {
    const stat = statCandidate(path.resolve(root, label));
    if (!stat?.isFile() || stat.size !== size || Math.trunc(stat.mtimeMs) !== mtimeMs) {
      return undefined;
    }
  }
  for (const label of walk.absentPaths) {
    // A directory is still a resolution miss, so only a FILE appearing here
    // moves an edge; that is the same question `walkDaemonCodeGraph` asked.
    if (statCandidate(path.resolve(root, label))?.isFile()) return undefined;
  }
  return walk;
}

function statCandidate(candidatePath: string): fs.Stats | undefined {
  try {
    return fs.statSync(candidatePath);
  } catch {
    return undefined;
  }
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

function readCachedWalk(cachePath: string): DaemonCodeGraphWalk | undefined {
  const document = readCachedDocument(cachePath);
  if (!document) return undefined;
  const files: DaemonCodeFileStamp[] = [];
  for (const entry of document.files) {
    const stamp = readStamp(entry);
    if (!stamp) return undefined;
    files.push(stamp);
  }
  if (!document.absent.every((label) => typeof label === 'string')) return undefined;
  return { files, absentPaths: document.absent as string[] };
}

/** The document's raw arrays, or `undefined` for anything this format cannot own. */
function readCachedDocument(
  cachePath: string,
): { files: unknown[]; absent: unknown[] } | undefined {
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
  if (!Array.isArray(document.files) || !Array.isArray(document.absent)) return undefined;
  return { files: document.files, absent: document.absent };
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

function publishWalk(cachePath: string, walk: DaemonCodeGraphWalk): void {
  const document: CacheDocument = {
    version: CACHE_FORMAT_VERSION,
    files: [...walk.files],
    absent: [...walk.absentPaths],
  };
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
