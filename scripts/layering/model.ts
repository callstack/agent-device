import path from 'node:path';
import { PLATFORMS } from '@agent-device/kernel/device';
import { parseSync } from 'oxc-parser';
import { visitAst } from './layering-ast.ts';

export type ImportEdge = {
  spec: string;
  dynamic: boolean;
  typeOnly: boolean;
  line: number;
  /** Named symbols imported from the target; empty for side-effect, namespace, and dynamic imports. */
  symbols: readonly string[];
};

export type ResolvedImportEdge = ImportEdge & {
  file: string;
  target: string;
  fromZone: string;
  toZone: string;
};

export type LayeringViolation = {
  rule: string;
  file: string;
  line: number;
  message: string;
};

export type BackEdgeMap = Record<string, string[]>;

// The ranked target spine. Back-edge detection is defined ONLY between two ranked
// zones: an edge whose source outranks its target (lower number imports higher) is a
// spine back-edge. Zones NOT in this map are intentionally unranked (see
// `UNRANKED_ZONES`); the gate does not rank them, so ranking their edges would claim a
// back-edge guarantee the code does not make. Every production zone must be either
// ranked here or listed as unranked — `unclassifiedZones` and `model.test.ts` guard
// that no zone is silently unclassified.
const TARGET_DAG_RANK = new Map([
  ['ad-replay', 1],
  ['ad-script', 1],
  ['contracts', 1],
  ['maestro', 1],
  ['recording', 1],
  ['replay-test', 1],
  ['request', 1],
  ['screenshot-diff', 1],
  ['selectors', 1],
  ['snapshot', 1],
  ['core', 2],
  ['cli-schema', 3],
  ['commands', 3],
  ['mcp', 3],
  ['ai-sdk', 4],
  ['client', 4],
  ['daemon-server', 4],
  ['metro', 4],
  ['remote', 4],
  ['sdk', 4],
  ['daemon-client', 5],
  ['cli', 6],
]);

export const RANKED_ZONES: ReadonlySet<string> = new Set(TARGET_DAG_RANK.keys());

/**
 * Spine rank of a zone, or `null` when the zone is intentionally unranked. The gate compares
 * ranks internally; this is exported for the dependency-graph report, which records the rank per
 * zone so a consumer can tell an inversion from an ordinary edge without re-deriving the spine.
 */
export function zoneRank(zone: string): number | null {
  return TARGET_DAG_RANK.get(zone) ?? null;
}

// Zones deliberately left OUT of the src folder spine. They are NOT unenforced:
// every file remains under the global value-cycle rule (R4). `(root)` composes
// the spine from above; extracted package zones are held by R11 package exports
// and the no-root-back-import rule instead of their former src folder rank.
//
// The satellite zones used to be listed here too, on the grounds that ranking them would
// invent an order the architecture had not committed to. Once `(root)` was emptied of shared
// contracts, every one of them turned out to have a consistent rank already — so the order was
// there, just unasserted. The former `utils` zone was retired into owning modules and packages.
// Extracted workspace packages are not src/ zones: R11 owns their physical seams, and their zone
// names only appear in workspace-aware graphs. The platform packages additionally carry R13's
// exact-family/composition/laziness policy.
export const UNRANKED_ZONES: ReadonlySet<string> = new Set([
  '(root)',
  // Private implementation submodules of the canonical root composition. R13 owns their exact
  // importer and concrete-platform authority; giving them a spine rank would duplicate that seam.
  'platform-runtime',
  'kernel',
  'host-kit',
  'capture-kit',
  'provision-kit',
  ...PLATFORMS.map((family) => `platform-${family}`),
  'provider-webdriver',
  'provider-limrun',
  'xml',
]);

export type ZoneClassification = 'ranked' | 'unranked' | 'unclassified';

export function classifyZone(zone: string): ZoneClassification {
  if (RANKED_ZONES.has(zone)) return 'ranked';
  if (UNRANKED_ZONES.has(zone)) return 'unranked';
  return 'unclassified';
}

function sourceLine(source: string, offset: number | null | undefined): number {
  const start = typeof offset === 'number' && offset >= 0 ? offset : 0;
  return source.slice(0, start).split('\n').length;
}

function literalSpecifier(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  if (record.type === 'Literal' && typeof record.value === 'string') return record.value;
  if (record.type === 'TemplateLiteral') {
    const expressions = record.expressions;
    const quasis = record.quasis;
    if (!Array.isArray(expressions) || expressions.length > 0 || !Array.isArray(quasis)) {
      return undefined;
    }
    const quasi = quasis[0];
    if (quasi === null || typeof quasi !== 'object') return undefined;
    const value = (quasi as Record<string, unknown>).value;
    if (value === null || typeof value !== 'object') return undefined;
    const cooked = (value as Record<string, unknown>).cooked;
    return typeof cooked === 'string' ? cooked : undefined;
  }
  if (
    record.type === 'ParenthesizedExpression' ||
    record.type === 'TSAsExpression' ||
    record.type === 'TSTypeAssertion' ||
    record.type === 'TSSatisfiesExpression' ||
    record.type === 'TSNonNullExpression'
  ) {
    return literalSpecifier(record.expression);
  }
  if (record.type === 'BinaryExpression' && record.operator === '+') {
    const left = literalSpecifier(record.left);
    const right = literalSpecifier(record.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function scanDynamicImports(source: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const parsed = parseSync('layering-imports.ts', source);
  visitAst(parsed.program, (node) => {
    if (node.type !== 'ImportExpression') return;
    const spec = literalSpecifier(node.source);
    if (spec === undefined) return;
    edges.push({
      spec,
      dynamic: true,
      typeOnly: false,
      line: sourceLine(source, node.start as number | undefined),
      symbols: [],
    });
  });
  return edges;
}

function scanSideEffectImport(line: string, lineNo: number): ImportEdge | null {
  const match = /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
  return match
    ? { spec: match[1]!, dynamic: false, typeOnly: false, line: lineNo, symbols: [] }
    : null;
}

function withoutImportComments(statement: string): string {
  return statement.replaceAll(
    /(["'])(?:\\.|(?!\1)[^\\\r\n])*?\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match) => (match.startsWith('/*') ? ' ' : match.startsWith('//') ? '\n' : match),
  );
}

type NamedSpecifier = { name: string; typeOnly: boolean };
type ParsedNamedSpecifiers = { index: number; specifiers: NamedSpecifier[] };

function parseNamedSpecifiers(statement: string): ParsedNamedSpecifiers | null {
  const named = /\{([\s\S]*?)\}/.exec(statement);
  if (!named) return null;

  const specifiers: NamedSpecifier[] = [];
  for (const specifier of named[1]!.split(',')) {
    const trimmed = specifier.trim();
    const typeOnly = /^type\b/.test(trimmed);
    const sourceName = trimmed.replace(/^type\s+/, '');
    const name = /^[A-Za-z_$][\w$]*/.exec(sourceName)?.[0];
    if (name) specifiers.push({ name, typeOnly });
  }
  return { index: named.index, specifiers };
}

function importedSymbols(statement: string): string[] {
  const parsed = parseNamedSpecifiers(statement);
  return [...new Set(parsed?.specifiers.map(({ name }) => name) ?? [])];
}

function statementIsTypeOnly(statement: string): boolean {
  if (/^\s*(?:import|export)\s+type\b/.test(statement)) return true;
  const parsed = parseNamedSpecifiers(statement);
  if (!parsed) return false;
  const prefix = statement
    .slice(0, parsed.index)
    .replace(/^\s*(?:import|export)\s+/, '')
    .trim()
    .replace(/,$/, '')
    .trim();
  if (prefix.length > 0) return false;
  return parsed.specifiers.length > 0 && parsed.specifiers.every(({ typeOnly }) => typeOnly);
}

function scanFromImport(lines: string[], index: number): ImportEdge | null {
  const fromMatch = /(?:^|[\s;}])from\s+['"]([^'"]+)['"]/.exec(lines[index]!);
  if (!fromMatch) return null;

  let start = index;
  while (start >= 0 && !/^\s*(?:import|export)\b/.test(lines[start]!)) start--;
  if (start < 0) return null;

  const statement = lines.slice(start, index + 1).join('\n');
  const normalizedStatement = withoutImportComments(statement);
  return {
    spec: fromMatch[1]!,
    dynamic: false,
    typeOnly: statementIsTypeOnly(normalizedStatement),
    line: start + 1,
    symbols: importedSymbols(normalizedStatement),
  };
}

export function parseImports(source: string): ImportEdge[] {
  const lines = source.split('\n');
  const dynamicImports = scanDynamicImports(source);
  const dynamicImportsByLine = new Map<number, ImportEdge[]>();
  for (const edge of dynamicImports) {
    const lineEdges = dynamicImportsByLine.get(edge.line) ?? [];
    lineEdges.push(edge);
    dynamicImportsByLine.set(edge.line, lineEdges);
  }
  const edges: ImportEdge[] = [];
  for (let index = 0; index < lines.length; index++) {
    edges.push(...(dynamicImportsByLine.get(index + 1) ?? []));
    const sideEffect = scanSideEffectImport(lines[index]!, index + 1);
    if (sideEffect) {
      edges.push(sideEffect);
      continue;
    }
    const fromImport = scanFromImport(lines, index);
    if (fromImport) edges.push(fromImport);
  }
  return edges;
}

export function topFolder(file: string): string {
  const packageMatch = /^packages\/([^/]+)\//.exec(file);
  if (packageMatch) return packageMatch[1]!;
  const match = /^src\/([^/]+)\//.exec(file);
  return match ? match[1]! : '(root)';
}

export function targetDagZone(file: string): string {
  if (file.startsWith('src/daemon/client/')) return 'daemon-client';
  if (file.startsWith('src/daemon/')) return 'daemon-server';
  return topFolder(file);
}

// The set of zones every production file resolves into. A zone that is neither ranked
// nor listed as intentionally unranked is an unclassified drift signal.
export function collectZones(files: readonly string[]): Set<string> {
  return new Set(files.map(targetDagZone));
}

// Zones present in `files` that are neither ranked nor intentionally unranked. A new
// `src/<folder>/` must be classified deliberately; leaving it unclassified would let
// its back-edges silently escape the ranked spine. Empty means the partition holds.
export function unclassifiedZones(files: readonly string[]): string[] {
  return [...collectZones(files)].filter((zone) => classifyZone(zone) === 'unclassified').sort();
}

// A relative specifier resolves only within a source root: root `src/`, or a workspace
// package's own `src/` (#1490 W0 added `packages/*/src/**` to the source set, but a bare
// `src/`-prefix check left every intra-package relative import — e.g. a facade re-exporting
// a sibling file — unresolved and invisible to the value-cycle and reverse-reachability graphs).
const PACKAGE_SRC_PREFIX = /^packages\/[^/]+\/src\//;

function resolveTargetFile(
  fromFile: string,
  spec: string,
  sourceFiles: ReadonlySet<string>,
  workspaceExportTargets?: ReadonlyMap<string, string>,
): string | null {
  if (spec.startsWith('@agent-device/')) {
    // Workspace specifier (#1490 W0). Real runs pass the exports-derived map
    // (workspaceSpecifierTargets), which is authoritative — it handles '.'
    // facade exports and any source layout. The positional fallback exists
    // only for map-less fixtures (the P0-pinned depgraph contract) and cannot
    // resolve a bare facade specifier by construction.
    if (workspaceExportTargets) {
      const target = workspaceExportTargets.get(spec);
      return target !== undefined && sourceFiles.has(target) ? target : null;
    }
    const [name, ...subParts] = spec.slice('@agent-device/'.length).split('/');
    const sub = subParts.join('/');
    if (!name || !sub) return null;
    return (
      [`packages/${name}/src/${sub}.ts`, `src/${name}/${sub}.ts`].find((candidate) =>
        sourceFiles.has(candidate),
      ) ?? null
    );
  }
  if (!spec.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (!resolved.startsWith('src/') && !PACKAGE_SRC_PREFIX.test(resolved)) return null;
  const candidates = [
    resolved,
    resolved.replace(/\.js$/, '.ts'),
    `${resolved}.ts`,
    path.posix.join(resolved, 'index.ts'),
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate)) ?? null;
}

export function resolveImportEdges(
  sources: ReadonlyMap<string, string>,
  workspaceExportTargets?: ReadonlyMap<string, string>,
): ResolvedImportEdge[] {
  const sourceFiles = new Set(sources.keys());
  const edges: ResolvedImportEdge[] = [];
  for (const [file, source] of sources) {
    for (const edge of parseImports(source)) {
      const target = resolveTargetFile(file, edge.spec, sourceFiles, workspaceExportTargets);
      if (!target) continue;
      edges.push({
        ...edge,
        file,
        target,
        fromZone: targetDagZone(file),
        toZone: targetDagZone(target),
      });
    }
  }
  return edges;
}

export function findValueImportCycles(edges: readonly ResolvedImportEdge[]): string[][] {
  const graph = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.dynamic || edge.typeOnly) continue;
    const targets = graph.get(edge.file) ?? new Set<string>();
    targets.add(edge.target);
    graph.set(edge.file, targets);
    if (!graph.has(edge.target)) graph.set(edge.target, new Set());
  }

  const indexByFile = new Map<string, number>();
  const lowLinkByFile = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  function visit(file: string): void {
    const index = nextIndex++;
    indexByFile.set(file, index);
    lowLinkByFile.set(file, index);
    stack.push(file);
    onStack.add(file);

    for (const target of graph.get(file) ?? []) {
      if (!indexByFile.has(target)) {
        visit(target);
        lowLinkByFile.set(file, Math.min(lowLinkByFile.get(file)!, lowLinkByFile.get(target)!));
      } else if (onStack.has(target)) {
        lowLinkByFile.set(file, Math.min(lowLinkByFile.get(file)!, indexByFile.get(target)!));
      }
    }

    if (lowLinkByFile.get(file) !== indexByFile.get(file)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== file);
    const selfCycle = component.length === 1 && graph.get(file)?.has(file);
    if (component.length > 1 || selfCycle) components.push(component);
  }

  for (const file of graph.keys()) {
    if (!indexByFile.has(file)) visit(file);
  }
  return components
    .map((component) => findCyclePath(component, graph))
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
}

function findCyclePath(
  component: readonly string[],
  graph: ReadonlyMap<string, Set<string>>,
): string[] {
  const members = new Set(component);
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const stack: string[] = [];

  function visit(file: string): string[] | null {
    visited.add(file);
    active.set(file, stack.length);
    stack.push(file);
    for (const target of graph.get(file) ?? []) {
      if (!members.has(target)) continue;
      const activeIndex = active.get(target);
      if (activeIndex !== undefined) return [...stack.slice(activeIndex), target];
      if (!visited.has(target)) {
        const path = visit(target);
        if (path) return path;
      }
    }
    stack.pop();
    active.delete(file);
    return null;
  }

  for (const file of [...component].sort()) {
    if (visited.has(file)) continue;
    const path = visit(file);
    if (path) return path;
  }
  throw new Error(`Expected a cycle inside strongly connected component: ${component.join(', ')}`);
}

function spineInversionPair(edge: ResolvedImportEdge): string | null {
  if (edge.fromZone === edge.toZone) return null;
  const fromRank = TARGET_DAG_RANK.get(edge.fromZone);
  const toRank = TARGET_DAG_RANK.get(edge.toZone);
  if (fromRank === undefined || toRank === undefined || fromRank >= toRank) return null;
  return `${edge.fromZone} -> ${edge.toZone}`;
}

export function backEdgePair(edge: ResolvedImportEdge): string | null {
  if (edge.dynamic || edge.typeOnly) return null;
  return spineInversionPair(edge);
}

// The same ranking applied to TYPE-ONLY edges (R6). R5 deliberately ignores them —
// a type-only import costs nothing at runtime and does not affect cold start — but a
// type-only edge still says "this zone is declared in terms of that one", and that IS a
// boundary claim. Ranking them found 61 inversions the gate had never seen, which is why
// they are ratcheted rather than merely reported: see `TYPE_INVERSION_BASELINE`.
export function typeInversionPair(edge: ResolvedImportEdge): string | null {
  if (edge.dynamic || !edge.typeOnly) return null;
  return spineInversionPair(edge);
}

export function collectBackEdges(edges: readonly ResolvedImportEdge[]): BackEdgeMap {
  const identitiesByPair = new Map<string, Set<string>>();
  for (const edge of edges) {
    const pair = backEdgePair(edge);
    if (!pair) continue;
    const identities = identitiesByPair.get(pair) ?? new Set<string>();
    identities.add(`${edge.file} -> ${edge.target}`);
    identitiesByPair.set(pair, identities);
  }
  return Object.fromEntries(
    [...identitiesByPair]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([pair, identities]) => [pair, [...identities].sort()]),
  );
}

/**
 * Size of the largest strongly-connected component over value AND type-only edges.
 *
 * R4 keeps the VALUE graph acyclic, so any cycle here is created by type-only imports. That costs
 * nothing at runtime — types are erased — but it bounds what can be read in isolation: every file
 * in the component transitively references every other one's declarations, so none of them has a
 * self-contained slice. Dynamic edges are excluded deliberately: a dynamic import is a lazy seam,
 * and a loop through one is not a comprehension barrier in the same way.
 *
 * Floor semantics, which are specified rather than incidental: only files that participate in at
 * least one non-dynamic edge are considered, so an acyclic graph reports 1 (every such file is its
 * own trivial component) and a graph whose only edges are dynamic reports 0 (no file enters the
 * walk). Both are immaterial to a growth ratchet, but they are pinned in model.test.ts so nobody
 * later reads 0 and 1 as a meaningful difference.
 */
export function largestTypeCycleSize(edges: readonly ResolvedImportEdge[]): number {
  return largestTypeCycleMembers(edges).length;
}

/** Members of the largest value+type strongly-connected component, sorted. */
export function largestTypeCycleMembers(edges: readonly ResolvedImportEdge[]): string[] {
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.dynamic) continue;
    const list = successors.get(edge.file) ?? [];
    list.push(edge.target);
    successors.set(edge.file, list);
  }

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  let next = 0;
  let biggest: string[] = [];

  function visit(file: string): void {
    index.set(file, next);
    lowLink.set(file, next);
    next++;
    stack.push(file);
    onStack.add(file);

    for (const target of successors.get(file) ?? []) {
      if (!index.has(target)) {
        visit(target);
        lowLink.set(file, Math.min(lowLink.get(file)!, lowLink.get(target)!));
      } else if (onStack.has(target)) {
        lowLink.set(file, Math.min(lowLink.get(file)!, index.get(target)!));
      }
    }

    if (lowLink.get(file) !== index.get(file)) return;
    const component: string[] = [];
    let member: string;
    do {
      member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
    } while (member !== file);
    if (component.length > biggest.length) biggest = component;
  }

  for (const file of successors.keys()) if (!index.has(file)) visit(file);
  return biggest.sort();
}
