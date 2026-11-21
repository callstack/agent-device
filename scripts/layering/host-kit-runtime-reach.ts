import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { nodeList, propertyName, type AstNode } from './layering-ast.ts';
import { parseImports } from './model.ts';

/**
 * The reach rule for a host-kit export a managed platform package imports at runtime.
 *
 * A managed plugin is bundled with its own copy of host-kit, and the daemon's command-host and
 * diagnostic scopes never enter that copy. So a runtime import of a host-kit module that reaches
 * `internal/exec.ts` or `internal/diagnostics.ts` runs its `ps`, PowerShell or `sysctl` probe with the
 * daemon process environment, and writes its diagnostics to the bundle's own store: the request that
 * made the call shows neither. Such a read belongs on the `PlatformHost` the core hands to `setup`,
 * which answers from the core's own copy inside the request scope.
 *
 * Which exports those are is a property of the host-kit module graph, not of a name list, so this
 * derives it from the runtime import edges and the re-export chains of each public subpath. A new
 * export that starts loading the exec layer through a new import is caught by the graph, with no list
 * to edit.
 */

/** The host-kit internals a managed plugin's bundled copy must never load. */
export const HOST_KIT_EXEC_ROOTS: readonly string[] = [
  'packages/host-kit/src/internal/exec.ts',
  'packages/host-kit/src/internal/diagnostics.ts',
];

/** Where host-kit's sources live: its public subpaths are the top-level modules below this. */
export const HOST_KIT_SOURCE_ROOT = 'packages/host-kit/src/';

/** The workspace specifier prefix every host-kit subpath is published under. */
export const HOST_KIT_SPECIFIER_PREFIX = '@agent-device/host-kit/';

/** One host-kit public subpath, as the module graph says it behaves. */
export type HostKitScopeSurface = Readonly<{
  /** The workspace specifier of the subpath, e.g. `@agent-device/host-kit/process`. */
  specifier: string;
  /** The host-kit source the subpath points at. */
  entry: string;
  /** Exported names whose declaration loads neither exec root. */
  pureExports: ReadonlySet<string>;
  /** Exported names whose declaration loads an exec root, directly or through the graph. */
  execExports: ReadonlySet<string>;
  /** Whether a re-export of a whole namespace means no name list can bound the subpath. */
  unbounded: boolean;
}>;

export type HostKitReachIndex = Readonly<{
  /** One surface per subpath whose entry is an indexed source, keyed by specifier. */
  surfaces: ReadonlyMap<string, HostKitScopeSurface>;
}>;

/** What one module says about itself: what it loads at runtime, and what it exports. */
type ModuleSurface = Readonly<{
  /** Specifiers this module loads at runtime, static or dynamic; unresolvable ones load outside. */
  imports: readonly string[];
  /** Names this module exports that it declares itself, as values. */
  declared: ReadonlySet<string>;
  /** Names this module exports as types only: a runtime import never binds one. */
  typeExports: ReadonlySet<string>;
  /** Exported name to the specifier and name it forwards. */
  forwarded: ReadonlyMap<string, Readonly<{ spec: string; name: string }>>;
  /** Whether this module re-exports a whole namespace. */
  starReexport: boolean;
}>;

/**
 * Indexes the host-kit module graph and answers for each public subpath which exported names load the
 * exec layer. `entries` maps a subpath specifier to its source file; a specifier whose entry is not an
 * indexed source is reported as stale rather than answered as an empty surface, so a rename or a move
 * cannot turn the rule green. `resolve` answers which indexed module a specifier from a given file
 * loads, or `undefined` for a module this index does not contain.
 */
export function indexHostKitReach(params: {
  /** The host-kit production sources to derive over, keyed by repo-root-relative path. */
  sources: ReadonlyMap<string, string>;
  entries: ReadonlyMap<string, string>;
  resolve: (fromFile: string, spec: string) => string | undefined;
}): HostKitReachIndex {
  const surfaces = new Map<string, ModuleSurface>();
  for (const [file, source] of params.sources) surfaces.set(file, readModuleSurface(source));
  const loadsExecRoot = (file: string, seen: Set<string>): boolean => {
    if (HOST_KIT_EXEC_ROOTS.includes(file)) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    const surface = surfaces.get(file);
    if (!surface) return false;
    return surface.imports.some((spec) => {
      const target = params.resolve(file, spec);
      return target !== undefined && loadsExecRoot(target, seen);
    });
  };
  const escapeMemo = new Map<string, boolean>();
  const escapes = (file: string): boolean => {
    const known = escapeMemo.get(file);
    if (known !== undefined) return known;
    const answer = loadsExecRoot(file, new Set());
    escapeMemo.set(file, answer);
    return answer;
  };
  const bySpecifier = new Map<string, HostKitScopeSurface>();
  for (const [specifier, entry] of params.entries) {
    // A specifier whose entry is not an indexed source is answered by no surface at all, so the caller
    // refuses an import of it rather than treating an unlocatable subpath as proven pure.
    if (!surfaces.has(entry)) continue;
    bySpecifier.set(specifier, scopeSurface(specifier, entry, surfaces, escapes, params.resolve));
  }
  return { surfaces: bySpecifier };
}

function scopeSurface(
  specifier: string,
  entry: string,
  surfaces: ReadonlyMap<string, ModuleSurface>,
  escapes: (file: string) => boolean,
  resolve: (fromFile: string, spec: string) => string | undefined,
): HostKitScopeSurface {
  const pureExports = new Set<string>();
  const execExports = new Set<string>();
  let unbounded = false;
  const seen = new Set<string>();
  const queue: Readonly<{ file: string; name: string }>[] = [];
  const push = (step: Readonly<{ file: string; name: string }>): void => {
    queue.push(step);
  };
  /** Follows one forwarded name to the module that declares it, or records it as unbounded proof. */
  const forward = (fromFile: string, exported: string, target: string): void => {
    const spec = surfaces.get(fromFile)?.forwarded.get(exported)?.spec;
    if (spec === undefined) {
      execExports.add(exported);
      return;
    }
    const resolved = resolve(fromFile, spec);
    if (resolved === undefined || !surfaces.has(resolved)) {
      // A forwarded name whose source the index cannot follow: nothing proves it loads no exec root.
      execExports.add(exported);
      return;
    }
    push({ file: resolved, name: target });
  };
  const start = surfaces.get(entry);
  if (start?.starReexport) unbounded = true;
  for (const name of start?.declared ?? []) push({ file: entry, name });
  for (const [exported, forwarded] of start?.forwarded ?? [])
    forward(entry, exported, forwarded.name);
  for (let head = 0; head < queue.length; head += 1) {
    const step = queue[head]!;
    const key = `${step.file}#${step.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const surface = surfaces.get(step.file);
    if (!surface) {
      execExports.add(step.name);
      continue;
    }
    if (surface.starReexport) unbounded = true;
    if (surface.declared.has(step.name)) {
      (escapes(step.file) ? execExports : pureExports).add(step.name);
      continue;
    }
    // A type export costs the bundle nothing at runtime, so it belongs to neither set.
    if (surface.typeExports.has(step.name)) continue;
    const forwarded = surface.forwarded.get(step.name);
    if (!forwarded) {
      // The subpath publishes a name this module neither declares nor forwards: its declaration site
      // is outside the index, so nothing proves it loads no exec root.
      execExports.add(step.name);
      continue;
    }
    forward(step.file, step.name, forwarded.name);
  }
  return { specifier, entry, pureExports, execExports, unbounded };
}

/**
 * The names of a runtime import that the subpath's derived allowlist does not vouch for: each one loads
 * the exec or diagnostic layer through the plugin's bundled copy, or is not an export at all and so has
 * no declaration the graph could vouch for.
 */
export function hostKitSymbolsReachingExec(
  surface: HostKitScopeSurface,
  symbols: readonly string[],
): readonly string[] {
  // An import that names no export — a namespace import, a bare import, or a dynamic import that does
  // not destructure — binds every export of the subpath, so it is refused when any export is not on the
  // allowlist, and refused outright when the subpath re-exports a namespace the index cannot bound.
  if (symbols.length === 0) {
    const unvouched = [...surface.execExports];
    if (unvouched.length > 0 || surface.unbounded) return unvouched.sort().concat('*');
    return [];
  }
  // A named import is safe only when the graph proves that name's declaration loads neither root.
  return symbols.filter((name) => !surface.pureExports.has(name));
}

/** The host-kit production sources of a scan input. */
export function hostKitSources(sources: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const subset = new Map<string, string>();
  for (const [file, source] of sources) {
    if (isHostKitProductionSource(file)) subset.set(file, source);
  }
  return subset;
}

/**
 * The public subpath entries of host-kit, read from the sources: every top-level module of
 * `packages/host-kit/src` is published under its own name. The scan input is the source of truth, so
 * the rule keeps no second list of subpaths.
 */
export function hostKitPublicEntries(
  sources: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const file of sources.keys()) {
    if (!isHostKitProductionSource(file)) continue;
    const subpath = file.slice(HOST_KIT_SOURCE_ROOT.length);
    if (subpath.includes('/')) continue;
    entries.set(`${HOST_KIT_SPECIFIER_PREFIX}${subpath.slice(0, -'.ts'.length)}`, file);
  }
  return entries;
}

function isHostKitProductionSource(file: string): boolean {
  if (!file.startsWith(HOST_KIT_SOURCE_ROOT) || !file.endsWith('.ts')) return false;
  const relative = file.slice(HOST_KIT_SOURCE_ROOT.length);
  return (
    !relative.includes('__tests__') &&
    !relative.endsWith('.test.ts') &&
    !relative.includes('.fixtures.') &&
    !relative.endsWith('fixtures.ts')
  );
}

/** Reads one module's runtime imports and its exported value, type and forwarded names. */
function readModuleSurface(source: string): ModuleSurface {
  const parsed = parseSync('host-kit-surface.ts', source);
  if (parsed.errors.length > 0) {
    throw new SyntaxError(
      `Cannot parse host-kit surface: ${parsed.errors.map(({ message }) => message).join('; ')}`,
    );
  }
  const edges = parseImports(source);
  const imports = edges.filter((edge) => !edge.typeOnly).map((edge) => edge.spec);
  // A name this module imported and then re-exports was declared elsewhere; its declaration site is
  // the specifier of that import.
  const importedFrom = new Map<string, Readonly<{ spec: string; name: string }>>();
  for (const edge of edges) {
    for (const name of edge.symbols) importedFrom.set(name, { spec: edge.spec, name });
  }
  const declared = new Set<string>();
  const typeExports = new Set<string>();
  const forwarded = new Map<string, Readonly<{ spec: string; name: string }>>();
  let starReexport = false;
  for (const statement of nodeList(asNode(parsed.program)?.body)) {
    const node = asNode(statement);
    if (!node) continue;
    if (node.type === 'ExportAllDeclaration') {
      if (node.exportKind !== 'type') starReexport = true;
      continue;
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    const spec = stringLiteral(node.source);
    const specifiers = nodeList(node.specifiers);
    if (spec !== undefined) {
      for (const name of exportedNames(specifiers, 'local')) {
        forwarded.set(name.exported, { spec, name: name.local });
      }
      continue;
    }
    const declaration = asNode(node.declaration);
    if (!declaration) {
      for (const name of exportedNames(specifiers, 'local')) {
        const binding = importedFrom.get(name.local);
        if (binding) forwarded.set(name.exported, binding);
        else declared.add(name.exported);
      }
      continue;
    }
    const isTypeOnly =
      declaration.type === 'TSTypeAliasDeclaration' ||
      declaration.type === 'TSInterfaceDeclaration' ||
      declaration.type === 'TSEnumDeclaration' ||
      declaration.type === 'TSModuleDeclaration';
    for (const name of declaredNames(declaration)) (isTypeOnly ? typeExports : declared).add(name);
    continue;
  }
  return { imports, declared, typeExports, forwarded, starReexport };
}

function exportedNames(
  specifiers: readonly unknown[],
  localField: 'local',
): Readonly<{ exported: string; local: string }>[] {
  return specifiers.flatMap((value) => {
    const specifier = asNode(value);
    if (!specifier || specifier.exportKind === 'type') return [];
    const local = propertyName(specifier[localField]);
    const exported = propertyName(specifier.exported) ?? local;
    return local === undefined || exported === undefined ? [] : [{ exported, local }];
  });
}

function declaredNames(declaration: AstNode): string[] {
  if (declaration.type === 'VariableDeclaration') {
    return nodeList(declaration.declarations).flatMap((value) => patternNames(asNode(value)?.id));
  }
  const name = propertyName(declaration.id);
  return name === undefined ? [] : [name];
}

function patternNames(node: unknown): string[] {
  const pattern = asNode(node);
  if (!pattern) return [];
  if (pattern.type === 'Identifier') {
    const name = propertyName(pattern.name);
    return name === undefined ? [] : [name];
  }
  if (pattern.type === 'ObjectPattern') {
    return nodeList(pattern.properties).flatMap((value) => {
      const property = asNode(value);
      if (!property) return [];
      return patternNames(property.type === 'RestElement' ? property.argument : property.value);
    });
  }
  if (pattern.type === 'ArrayPattern') return nodeList(pattern.elements).flatMap(patternNames);
  if (pattern.type === 'AssignmentPattern') return patternNames(pattern.left);
  if (pattern.type === 'RestElement') return patternNames(pattern.argument);
  return [];
}

function asNode(value: unknown): AstNode | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.type === 'string' ? (record as AstNode) : undefined;
}

function stringLiteral(node: unknown): string | undefined {
  const source = asNode(node);
  return typeof source?.value === 'string' ? source.value : undefined;
}

/** Joins a relative specifier with the file that wrote it, in repo-root-relative posix form. */
export function resolveRelativeSource(fromFile: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
}
