import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findProjectRoot } from './version.ts';

// Any quoted, relative-path-shaped string literal is treated as a module
// specifier, rather than matching the `import`/`export`/`from` grammar
// around it: bundlers only ever emit relative string literals for real
// specifiers, but the surrounding syntax varies too much to track reliably —
// formatted source spaces `import { x } from './y'` out, a minified build
// (tsdown/rolldown `minify: true`) squashes it to `import{x}from"./y"`, and a
// keyword-anchored regex tuned for one silently stops matching the other
// (#1545: the daemon's own built entry fingerprinted to just itself, since
// nothing downstream of it ever matched). A literal that isn't really an
// import (e.g. one that shows up inside a comment) simply fails to resolve
// to a file below and gets dropped, so over-matching here is harmless.
const RELATIVE_SPECIFIER_RE = /(['"])(\.\.?\/[^'"]*)\1/g;
// Workspace specifiers are matched separately and only in their scoped form.
// Every literal that looks like a bare name would otherwise be probed against
// `node_modules`, and each miss is an `absentPaths` entry the cache re-stats on
// every invocation — prose strings would fill the document. A scoped shape is
// specific enough to keep that set to the specifiers a module really imports.
const SCOPED_SPECIFIER_RE = /(['"])(@[^'"/\s]+\/[^'"\s]+)\1/g;
const RESOLVABLE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

/**
 * One visited module's contribution to the fingerprint: the label it is
 * recorded under (repository-relative where possible) and the `size:mtime`
 * pair that stands in for its contents. Contents are never hashed — a
 * same-length rewrite inside one filesystem timestamp tick is deliberately
 * out of scope, and `code-signature-cache.ts` reuses exactly this bound.
 */
export type DaemonCodeFileStamp = readonly [label: string, size: number, mtimeMs: number];

/**
 * One walk of the graph: the stamps that make up its signature, plus the paths
 * whose ABSENCE that shape depended on.
 *
 * A file OUTSIDE the graph can still decide the graph. `./dep` means `dep.js`
 * only for as long as `dep.ts` does not exist, because resolution probes the
 * extensions in `RESOLVABLE_EXTENSIONS` order — and a specifier that resolves
 * to nothing today is an edge whose target merely has not been written yet.
 * `absentPaths` therefore carries every candidate probed and missed ahead of a
 * specifier's winner, and every candidate of a specifier with no winner at
 * all: creating any one of them redirects or adds an edge. A workspace
 * specifier rests on one more absence — the package manifest that is not
 * installed yet — and, when it IS installed, on the manifest's contents, which
 * is why the manifest is stamped in `files` rather than merely probed: an
 * `exports` edit retargets the edge without touching either endpoint.
 * Together the two are the complete input to this walk, which is what lets
 * `code-signature-cache.ts` replay the result from `statSync` alone.
 */
export type DaemonCodeGraphWalk = {
  readonly files: readonly DaemonCodeFileStamp[];
  readonly absentPaths: readonly string[];
};

export function resolveDaemonCodeSignature(): string {
  const entryPath = process.argv[1];
  if (!entryPath) return 'unknown';
  return computeDaemonCodeSignature(entryPath);
}

export function computeDaemonCodeSignature(
  entryPath: string,
  root: string = findProjectRoot(),
): string {
  try {
    return formatDaemonCodeSignature(walkDaemonCodeGraph(entryPath, root).files);
  } catch {
    return 'unknown';
  }
}

/**
 * Stamps every module reachable from `entryPath` through relative import
 * specifiers and through workspace package subpaths, and records what every
 * resolution along the way needed to be missing. Throws when the entry itself
 * cannot be read; callers decide whether that is an `'unknown'` signature or a
 * cache miss.
 *
 * Following workspace subpaths is what keeps this a signature of the code the
 * daemon RUNS. A source checkout imports most of its own implementation by
 * specifier, so a walk that stopped at the first `@scope/name` would stamp a
 * shrinking fraction of the daemon and report an unchanged signature after an
 * edit to any of it — including an edit to this walker, which the cache's
 * format guard relies on being inside the graph it walks.
 */
export function walkDaemonCodeGraph(entryPath: string, root: string): DaemonCodeGraphWalk {
  const normalizedRoot = path.resolve(root);
  const queue = [path.resolve(entryPath)];
  const visited = new Set<string>();
  const files: DaemonCodeFileStamp[] = [];
  const absentPaths = new Set<string>();

  const context: WalkContext = {
    root: normalizedRoot,
    packages: new Map(),
    absentPaths,
    stamp: (filePath) => {
      if (visited.has(filePath)) return false;
      visited.add(filePath);
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return false;
      const label = buildDaemonCodeFileLabel(normalizedRoot, filePath);
      files.push([label, stat.size, Math.trunc(stat.mtimeMs)]);
      return true;
    },
    follow: (resolution) => {
      for (const missed of resolution.missedCandidates) {
        absentPaths.add(buildDaemonCodeFileLabel(normalizedRoot, missed));
      }
      if (resolution.filePath) queue.push(resolution.filePath);
    },
  };

  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (currentPath === undefined || visited.has(currentPath)) continue;
    if (!context.stamp(currentPath)) continue;

    const content = fs.readFileSync(currentPath, 'utf8');
    for (const specifier of collectRelativeImportSpecifiers(content)) {
      context.follow(resolveRelativeImportPath(currentPath, specifier));
    }
    followWorkspaceSubpaths(content, context);
  }

  return { files, absentPaths: [...absentPaths] };
}

/** What the walk hands its resolution helpers: where it is, and how to record what they find. */
type WalkContext = {
  readonly root: string;
  /** One answer per package name; a manifest is read and stamped at most once per walk. */
  readonly packages: Map<string, WorkspacePackage | null>;
  readonly absentPaths: Set<string>;
  /** Stamps a file, reporting whether this walk had not already visited it. */
  stamp(filePath: string): boolean;
  follow(resolution: ImportResolution): void;
};

function followWorkspaceSubpaths(content: string, context: WalkContext): void {
  for (const specifier of collectScopedSpecifiers(content)) {
    const { name, subpath } = splitPackageSpecifier(specifier);
    const owner = resolveWorkspaceOwner(name, context);
    if (!owner) continue;
    const target = readExportTarget(owner.manifest, subpath);
    if (target === undefined) continue;
    context.follow(resolveRelativeImportPath(owner.manifestPath, target));
  }
}

/**
 * The package that owns `name`, stamping its manifest the first time this walk
 * needs it: the manifest decides which file the subpath names, so it belongs in
 * the fingerprint of every graph that crosses it.
 */
function resolveWorkspaceOwner(name: string, context: WalkContext): WorkspacePackage | null {
  const cached = context.packages.get(name);
  if (cached !== undefined) return cached;
  const owner = readWorkspacePackage(context.root, name, context.absentPaths);
  context.packages.set(name, owner);
  if (owner) context.stamp(owner.manifestPath);
  return owner;
}

/**
 * The label a visited module is stamped under: repository-relative where
 * possible, absolute when it lies outside the root. `code-signature-cache.ts`
 * derives the ENTRY's label through this same function, so a stored document
 * that does not list it cannot be a document for this graph.
 */
export function buildDaemonCodeFileLabel(root: string, filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return path.relative(path.resolve(root), resolvedPath) || resolvedPath;
}

/** The wire form of a signature; identical for a walked and a cache-validated stamp list. */
export function formatDaemonCodeSignature(stamps: readonly DaemonCodeFileStamp[]): string {
  const fingerprint = stamps
    .map(([label, size, mtimeMs]) => `${label}:${size}:${mtimeMs}`)
    .sort()
    .join('|');
  const hash = crypto.createHash('sha1').update(fingerprint).digest('hex');
  return `graph:${stamps.length}:${hash}`;
}

function collectRelativeImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  RELATIVE_SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = RELATIVE_SPECIFIER_RE.exec(content)) !== null) {
    specifiers.add(match[2]!);
  }
  return [...specifiers];
}

function collectScopedSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  SCOPED_SPECIFIER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = null;
  while ((match = SCOPED_SPECIFIER_RE.exec(content)) !== null) {
    specifiers.add(match[2]!);
  }
  return [...specifiers];
}

/** A workspace package this walk may follow into, and the manifest that says how. */
type WorkspacePackage = {
  readonly manifestPath: string;
  readonly manifest: unknown;
};

/** `@scope/name/deep/path` as the package that owns it and the subpath it asks for. */
function splitPackageSpecifier(specifier: string): { name: string; subpath: string } {
  const segments = specifier.split('/');
  const rest = segments.slice(2).join('/');
  return { name: segments.slice(0, 2).join('/'), subpath: rest ? `./${rest}` : '.' };
}

/**
 * The workspace package `name` resolves to from this checkout, or `null` for
 * anything this walk does not follow.
 *
 * Resolution starts at the checkout root rather than walking up from the
 * importing file: every workspace link in the tree points at the same source
 * directory, so the extra probes could only find the same package again while
 * adding an `absentPaths` entry per directory level per specifier — a document
 * the cache would then re-stat thousands of times per invocation.
 *
 * An INSTALLED dependency is deliberately not followed. Its contents change on
 * install rather than on edit, and its closure dwarfs the graph this signature
 * describes. The test is structural: a workspace link resolves out of
 * `node_modules`, an installed dependency resolves within it.
 */
function readWorkspacePackage(
  root: string,
  name: string,
  absentPaths: Set<string>,
): WorkspacePackage | null {
  const linkedManifestPath = path.join(root, 'node_modules', name, 'package.json');
  if (!isExistingFile(linkedManifestPath)) {
    absentPaths.add(buildDaemonCodeFileLabel(root, linkedManifestPath));
    return null;
  }
  const manifestPath = realManifestPath(linkedManifestPath);
  if (isInstalledDependencyPath(root, manifestPath)) return null;
  try {
    return { manifestPath, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
  } catch {
    return null;
  }
}

/**
 * The manifest's own path, so a package reached through its workspace link is
 * stamped under one label. Both routes name the same inode, so either would
 * revalidate; two labels for one file would just inflate every document.
 */
function realManifestPath(manifestPath: string): string {
  try {
    return fs.realpathSync.native(manifestPath);
  } catch {
    return manifestPath;
  }
}

function isInstalledDependencyPath(root: string, filePath: string): boolean {
  const relative = path.relative(path.join(root, 'node_modules'), filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The file an `exports` map names for `subpath`, as a specifier relative to the
 * manifest. Conditions are not evaluated: every condition of one subpath in
 * this workspace names the same source file, and picking the wrong one of two
 * identical answers is not a failure mode worth a resolver for.
 */
function readExportTarget(manifest: unknown, subpath: string): string | undefined {
  if (!manifest || typeof manifest !== 'object') return undefined;
  const exports = (manifest as { exports?: unknown }).exports;
  if (!exports || typeof exports !== 'object') return undefined;
  const entry = (exports as Record<string, unknown>)[subpath];
  const target = typeof entry === 'string' ? entry : readDefaultCondition(entry);
  return typeof target === 'string' && target.startsWith('.') ? target : undefined;
}

function readDefaultCondition(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return undefined;
  return (entry as { default?: unknown }).default;
}

/**
 * What one specifier resolves to, and what that answer rests on: the
 * candidates probed and missed AHEAD of the winner. Candidates behind it are
 * never reached, so creating one of those cannot move the resolution and none
 * is reported.
 */
type ImportResolution = {
  readonly filePath: string | null;
  readonly missedCandidates: readonly string[];
};

function resolveRelativeImportPath(fromPath: string, specifier: string): ImportResolution {
  const basePath = path.resolve(path.dirname(fromPath), specifier);
  const missedCandidates: string[] = [];
  for (const candidatePath of resolutionCandidates(basePath)) {
    if (isExistingFile(candidatePath)) return { filePath: candidatePath, missedCandidates };
    missedCandidates.push(candidatePath);
  }
  return { filePath: null, missedCandidates };
}

/** Every path the specifier could name, in the order resolution prefers them. */
function* resolutionCandidates(basePath: string): Generator<string> {
  yield basePath;
  for (const extension of RESOLVABLE_EXTENSIONS) yield `${basePath}${extension}`;
  for (const extension of RESOLVABLE_EXTENSIONS) yield path.join(basePath, `index${extension}`);
}

function isExistingFile(candidatePath: string): boolean {
  try {
    return fs.statSync(candidatePath).isFile();
  } catch {
    return false;
  }
}
