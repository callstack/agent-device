import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishFileSync } from '../utils/atomic-file.ts';
import {
  formatDaemonCodeSignature,
  walkDaemonCodeGraph,
  type DaemonCodeFileStamp,
} from './code-signature.ts';

// Bump when the stored shape changes; old documents then miss instead of
// parsing wrong. Only this module needs the guard: `code-signature.ts` is
// itself inside the graph it walks, so changing the WALK invalidates every
// document through the ordinary stamp comparison.
const CACHE_FORMAT_VERSION = 1;
const CACHE_DIRECTORY_NAME = 'agent-device-code-signature';

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
 * So the walk is cached and revalidated by `statSync` alone. That is sound
 * against the walk it replaces, not merely close to it: the signature already
 * treats a file's `size:mtime` as the stand-in for its contents
 * (`DaemonCodeFileStamp`), so if every previously visited file still carries
 * its recorded pair, no file's contents changed, therefore no import
 * specifier changed, therefore the graph and its signature are unchanged. Any
 * mismatched, vanished, or newly non-file entry, and any unreadable or
 * malformed cache document, falls back to the full walk, which republishes.
 *
 * The cache is a best-effort artifact under `os.tmpdir()`, like the Swift
 * toolchain cache: failing to read or write one only costs the walk.
 */
export function resolveCachedDaemonCodeSignature(entryPath: string, root: string): string {
  const cachePath = resolveCachePath(entryPath, root);
  const validated = readValidatedStamps(cachePath, root);
  if (validated) return formatDaemonCodeSignature(validated);

  let stamps: DaemonCodeFileStamp[];
  try {
    stamps = walkDaemonCodeGraph(entryPath, root);
  } catch {
    return 'unknown';
  }
  publishStamps(cachePath, stamps);
  return formatDaemonCodeSignature(stamps);
}

/** The recorded stamps when every one of them still describes the file on disk. */
function readValidatedStamps(cachePath: string, root: string): DaemonCodeFileStamp[] | undefined {
  const stamps = readCachedStamps(cachePath);
  if (!stamps) return undefined;
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const document = parsed as Partial<CacheDocument>;
  if (document.version !== CACHE_FORMAT_VERSION) return undefined;
  return Array.isArray(document.files) ? document.files : undefined;
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
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    publishFileSync({ destination: cachePath, contents: JSON.stringify(document) });
  } catch {
    // Best effort: an uncached signature is still a correct signature.
  }
}

/** One document per (entry, root) pair, so sibling checkouts never share one. */
function resolveCachePath(entryPath: string, root: string): string {
  const key = crypto
    .createHash('sha1')
    .update(`${path.resolve(root)} ${path.resolve(entryPath)}`)
    .digest('hex');
  return path.join(os.tmpdir(), CACHE_DIRECTORY_NAME, `${key}.json`);
}
