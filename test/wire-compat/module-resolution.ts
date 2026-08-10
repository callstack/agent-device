/**
 * Where does a type name a wire declaration references actually come from?
 * (#1432, review P1: imported payload shapes escaped the closure.)
 *
 * The first version of the closure check only scanned the manifest's own files
 * and silently skipped any name it could not place. That made the claim hollow
 * in exactly the case that matters: a listed type could grow
 * `foo?: ImportedShape` from a module nobody had listed, and the declaration
 * deciding what the peer parses stayed ungated while every test passed.
 *
 * So resolution is explicit and FAILS CLOSED. A referenced name is acceptable
 * only when it lands in one of three places, each of which someone had to
 * write down: a repo file (then it must be listed or waived), a module the
 * manifest declares external, or the TypeScript global set.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

export type ResolvedOrigin =
  /** Declared or imported from a file inside this repository. */
  | { kind: 'repo'; file: string; name: string }
  /** Imported from a module the manifest lists as an external leaf. */
  | { kind: 'external'; specifier: string; name: string }
  /** A TypeScript global (`Record`, `Partial`, `ReturnType`, …). */
  | { kind: 'global'; name: string }
  /** Nothing could place it — the fail-closed case. */
  | { kind: 'unresolved'; name: string };

/**
 * Ambient TypeScript/ES types that have no declaration site in this repo. They
 * shape a payload only through their arguments, and every argument is itself a
 * reference the walk already visits (`Partial<DaemonRequest>` reports
 * `DaemonRequest`), so treating the constructor as a leaf loses nothing.
 */
const TS_GLOBALS = new Set([
  'Array',
  'Awaited',
  'Date',
  'Error',
  'Exclude',
  'Extract',
  'Map',
  'NonNullable',
  'Omit',
  'Parameters',
  'Partial',
  'Pick',
  'Promise',
  'PromiseLike',
  'Readonly',
  'ReadonlyArray',
  'Record',
  'RegExp',
  'Required',
  'ReturnType',
  'Set',
  'URL',
  'URLSearchParams',
  'Uint8Array',
  'WeakMap',
]);

/**
 * Node globals that reach a declaration's types without an import. Same
 * reasoning as TS_GLOBALS: no declaration site in this repo to digest.
 */
const NODE_GLOBALS = new Set(['Buffer', 'NodeJS']);

type ImportBinding = { specifier: string; importedName: string };

/** Name → module it is re-exported from, for one module's `export … from` list. */
function reExportBindings(file: string, source: string): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const parsed = parseSync(file, source);
  for (const staticExport of parsed.module.staticExports) {
    for (const entry of staticExport.entries) {
      const specifier = entry.moduleRequest?.value;
      const exported = entry.exportName.kind === 'Name' ? entry.exportName.name : null;
      if (!specifier || !exported) continue;
      bindings.set(exported, {
        specifier,
        importedName:
          entry.localName.kind === 'Name' ? (entry.localName.name ?? exported) : exported,
      });
    }
  }
  return bindings;
}

/** Local name → where it was imported from, for one module. */
function importBindings(file: string, source: string): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const parsed = parseSync(file, source);
  for (const staticImport of parsed.module.staticImports) {
    const specifier = staticImport.moduleRequest.value;
    for (const entry of staticImport.entries) {
      const importedName =
        entry.importName.kind === 'Name' ? (entry.importName.name ?? '') : entry.localName.value;
      bindings.set(entry.localName.value, { specifier, importedName });
    }
  }
  return bindings;
}

// Two forms reach repo code: relative specifiers carry their `.ts` extension
// here, so they resolve by path; workspace specifiers go through exports maps.
function resolveRelative(repoRoot: string, fromFile: string, specifier: string): string | null {
  const resolved = path.resolve(path.dirname(path.join(repoRoot, fromFile)), specifier);
  return fs.existsSync(resolved) ? path.relative(repoRoot, resolved) : null;
}

/**
 * Resolves through the owning package's own `exports` map rather than guessing
 * `packages/<name>/src/<sub>.ts`: the map is where the package declares which
 * file backs a subpath, so a re-pointed export cannot silently drop a type out
 * of the closure.
 */
function resolveWorkspace(repoRoot: string, specifier: string): string | null {
  const workspace = /^@agent-device\/([^/]+)(?:\/(.+))?$/.exec(specifier);
  if (!workspace) return null;

  const packageDir = path.join('packages', workspace[1]!);
  const manifestPath = path.join(repoRoot, packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    exports?: Record<string, { types?: string; default?: string }>;
  };
  const subpath = workspace[2] ? `./${workspace[2]}` : '.';
  const target = manifest.exports?.[subpath] ?? {};
  const entry = target.types ?? target.default;
  if (!entry) return null;

  const relative = path.join(packageDir, entry);
  return fs.existsSync(path.join(repoRoot, relative)) ? relative : null;
}

/** Repo-relative file a specifier points at, or null when it leaves the repo. */
function resolveModuleFile(repoRoot: string, fromFile: string, specifier: string): string | null {
  return specifier.startsWith('.')
    ? resolveRelative(repoRoot, fromFile, specifier)
    : resolveWorkspace(repoRoot, specifier);
}

export type OriginResolver = (file: string, name: string) => ResolvedOrigin;

/**
 * Builds a resolver that answers, for a name referenced inside `file`, where
 * its declaration lives. `declaresLocally` reports whether a file declares a
 * top-level name, and `externalSpecifier` decides whether a specifier the
 * manifest could not follow is an accepted external leaf.
 */
export function createOriginResolver(options: {
  repoRoot: string;
  readSource: (file: string) => string;
  declaresLocally: (file: string, name: string) => boolean;
  isExternalSpecifier: (specifier: string) => boolean;
}): OriginResolver {
  const { repoRoot, readSource, declaresLocally, isExternalSpecifier } = options;
  const importsByFile = new Map<string, Map<string, ImportBinding>>();
  const reExportsByFile = new Map<string, Map<string, ImportBinding>>();

  function cached(
    cache: Map<string, Map<string, ImportBinding>>,
    file: string,
    read: (file: string, source: string) => Map<string, ImportBinding>,
  ): Map<string, ImportBinding> {
    let bindings = cache.get(file);
    if (!bindings) {
      bindings = read(file, readSource(file));
      cache.set(file, bindings);
    }
    return bindings;
  }

  /**
   * Follows `export { X } from './y.ts'` chains. A façade re-exporting a wire
   * type must land on the file that DECLARES it, or the closure would key on
   * the façade — which declares nothing — and report the real declaration as
   * missing while the façade itself can never be digested.
   */
  function throughReExports(file: string, name: string, depth = 0): ResolvedOrigin {
    if (declaresLocally(file, name)) return { kind: 'repo', file, name };
    if (depth > 8) return { kind: 'unresolved', name };

    const binding = cached(reExportsByFile, file, reExportBindings).get(name);
    if (!binding) return { kind: 'repo', file, name };

    const resolved = resolveModuleFile(repoRoot, file, binding.specifier);
    if (resolved) return throughReExports(resolved, binding.importedName, depth + 1);
    if (isExternalSpecifier(binding.specifier)) {
      return { kind: 'external', specifier: binding.specifier, name: binding.importedName };
    }
    return { kind: 'unresolved', name };
  }

  return (file, name) => {
    if (declaresLocally(file, name)) return { kind: 'repo', file, name };

    const binding = cached(importsByFile, file, importBindings).get(name);
    if (!binding) {
      return TS_GLOBALS.has(name) || NODE_GLOBALS.has(name)
        ? { kind: 'global', name }
        : { kind: 'unresolved', name };
    }

    const resolved = resolveModuleFile(repoRoot, file, binding.specifier);
    if (resolved) return throughReExports(resolved, binding.importedName);
    if (isExternalSpecifier(binding.specifier)) {
      return { kind: 'external', specifier: binding.specifier, name: binding.importedName };
    }
    return { kind: 'unresolved', name };
  };
}
