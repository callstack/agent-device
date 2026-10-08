import path from 'node:path';
import { PLATFORMS } from '@agent-device/kernel/device';
import { createGraph, genDFS, getStronglyConnectedComponents, getSubgraph } from '@statelyai/graph';
import { parseSync } from 'oxc-parser';
import { destructuredDynamicImportBindings, visitAst } from './layering-ast.ts';
import { declaredRootModuleZone } from './root-module-zones.ts';
import {
  importGraphFromResolvedEdges,
  STATIC_EDGES,
  VALUE_EDGES,
} from '../depgraph/import-graph.ts';

export type ImportEdge = {
  spec: string;
  dynamic: boolean;
  typeOnly: boolean;
  line: number;
  /**
   * Named symbols imported from the target; empty for side-effect and namespace imports, and for
   * dynamic imports that do not destructure named bindings.
   */
  symbols: readonly string[];
  /**
   * True when a dynamic-import destructure holds a binding the scanner cannot name (a rest element
   * or a computed key); `symbols` then does not enumerate the full imported surface.
   */
  bindingResidue: boolean;
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
  ['command-registry', 1],
  ['contracts', 1],
  ['device-selection', 1],
  ['maestro', 1],
  ['replay-port', 1],
  ['replay-test', 1],
  ['screenshot-diff', 1],
  ['selectors', 1],
  ['session-journal', 1],
  ['core', 2],
  ['daemon-contracts', 2],
  ['command-runtime', 3],
  ['commands', 3],
  ['mcp', 3],
  ['client', 4],
  ['daemon-server', 4],
  ['metro', 4],
  ['platform-runtime', 4],
  ['remote', 4],
  ['plugins', 4],
  ['daemon-client', 5],
  // The SDK entries publish the typed client, which reaches the daemon through daemon-client.
  ['ai-sdk', 6],
  ['sdk', 6],
  ['cli', 7],
  // Reached only through `loadHost`'s import(), so every spine zone ranks below it.
  ['platform-runtime-host', 8],
  ['(root)', 9],
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
// every file remains under the global value-cycle rule (R4) and the zone-level value DAG
// (R80). Extracted package zones are held by R11 package exports and the no-root-back-import
// rule instead of a src folder rank.
//
// Every other src/ zone is ranked, `(root)` included: root modules declare their zone in
// `root-module-zones.ts`, and `(root)` ranks above the spine. Extracted workspace packages are
// not src/ zones: R11 owns their physical seams, and their zone names only appear in
// workspace-aware graphs. The platform packages additionally carry R13's
// exact-family/composition/laziness policy.
export const UNRANKED_ZONES: ReadonlySet<string> = new Set([
  // Stand-ins the bundler resolves in place of a dependency it deliberately omits. Nothing in
  // the production graph imports them, so ranking them would claim an edge the alias replaces.
  'vendor',
  'kernel',
  'host-kit',
  'capture-kit',
  'managed-allocation',
  'provision-kit',
  ...PLATFORMS.map((family) => `platform-${family}`),
  'provider-webdriver',
  'provider-limrun',
  'provider-testmu',
  'proxy',
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

type LocatedImportEdge = { edge: ImportEdge; start: number; order: number };

function importedName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as Record<string, unknown>;
  return record.type === 'Identifier' && typeof record.name === 'string' ? record.name : undefined;
}

function namedSymbols(
  specifiers: readonly Record<string, unknown>[],
  importedField: 'imported' | 'local',
): string[] {
  const symbols = specifiers.flatMap((specifier) => {
    const name = importedName(specifier[importedField]);
    return specifier.type ===
      (importedField === 'imported' ? 'ImportSpecifier' : 'ExportSpecifier') && name !== undefined
      ? [name]
      : [];
  });
  return [...new Set(symbols)];
}

function specifierTypeOnly(
  declaration: Record<string, unknown>,
  specifiers: readonly Record<string, unknown>[],
  kindField: 'importKind' | 'exportKind',
): boolean {
  if (declaration[kindField] === 'type') return true;
  return specifiers.length > 0 && specifiers.every((specifier) => specifier[kindField] === 'type');
}

function staticImportEdge(
  source: string,
  node: Record<string, unknown>,
  specifierNode: unknown,
  typeOnly: boolean,
  symbols: string[],
): ImportEdge | null {
  const spec = literalSpecifier(specifierNode);
  if (spec === undefined) return null;
  const start = node.start as number | undefined;
  return {
    spec,
    dynamic: false,
    typeOnly,
    line: sourceLine(source, start),
    symbols,
    bindingResidue: false,
  };
}

export function parseImports(source: string): ImportEdge[] {
  const parsed = parseSync('layering-imports.ts', source);
  const destructured = destructuredDynamicImportBindings(parsed.program);
  const located: LocatedImportEdge[] = [];
  let order = 0;

  visitAst(parsed.program, (node) => {
    const start = typeof node.start === 'number' ? node.start : 0;
    if (node.type === 'ImportExpression') {
      const spec = literalSpecifier(node.source);
      if (spec === undefined) return;
      const capture = destructured.get(start);
      located.push({
        start,
        order: order++,
        edge: {
          spec,
          dynamic: true,
          typeOnly: false,
          line: sourceLine(source, start),
          symbols: capture ? [...capture.symbols] : [],
          bindingResidue: capture?.residue ?? false,
        },
      });
      return;
    }

    let edge: ImportEdge | null = null;
    if (node.type === 'ImportDeclaration') {
      const specifiers = Array.isArray(node.specifiers)
        ? (node.specifiers as Record<string, unknown>[])
        : [];
      edge = staticImportEdge(
        source,
        node,
        node.source,
        specifierTypeOnly(node, specifiers, 'importKind'),
        namedSymbols(specifiers, 'imported'),
      );
    } else if (node.type === 'ExportNamedDeclaration' && node.source) {
      const specifiers = Array.isArray(node.specifiers)
        ? (node.specifiers as Record<string, unknown>[])
        : [];
      edge = staticImportEdge(
        source,
        node,
        node.source,
        specifierTypeOnly(node, specifiers, 'exportKind'),
        namedSymbols(specifiers, 'local'),
      );
    } else if (node.type === 'ExportAllDeclaration') {
      edge = staticImportEdge(source, node, node.source, node.exportKind === 'type', []);
    } else if (node.type === 'TSImportType') {
      edge = staticImportEdge(source, node, node.source, true, []);
    }
    if (edge) located.push({ edge, start, order: order++ });
  });

  return located
    .sort(
      (left, right) =>
        left.edge.line - right.edge.line ||
        Number(right.edge.dynamic) - Number(left.edge.dynamic) ||
        left.start - right.start ||
        left.order - right.order,
    )
    .map(({ edge }) => edge);
}

export function topFolder(file: string): string {
  const packageMatch = /^packages\/([^/]+)\//.exec(file);
  if (packageMatch) return packageMatch[1]!;
  const match = /^src\/([^/]+)\//.exec(file);
  return match ? match[1]! : '(root)';
}

export function targetDagZone(file: string): string {
  // #2342 relocated the daemon client to its own `src/daemon-client/` folder, so the
  // client zone now falls out of the folder itself; `src/daemon/` is server-only.
  if (file.startsWith('src/daemon/')) return 'daemon-server';
  return declaredRootModuleZone(file) ?? topFolder(file);
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

export type ImportParser = (source: string) => ImportEdge[];

/**
 * `parseImports` memoized by source text. A ratchet parses two trees that share almost every
 * file, so the second tree costs a parse only where its text differs from the first.
 */
export function memoizedImportParser(): ImportParser {
  const edgesBySource = new Map<string, ImportEdge[]>();
  return (source) => {
    let edges = edgesBySource.get(source);
    if (!edges) {
      edges = parseImports(source);
      edgesBySource.set(source, edges);
    }
    return edges;
  };
}

export function resolveImportEdges(
  sources: ReadonlyMap<string, string>,
  workspaceExportTargets?: ReadonlyMap<string, string>,
  parse: ImportParser = parseImports,
): ResolvedImportEdge[] {
  const sourceFiles = new Set(sources.keys());
  const edges: ResolvedImportEdge[] = [];
  for (const [file, source] of sources) {
    for (const edge of parse(source)) {
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
  const graph = importGraphFromResolvedEdges(edges, VALUE_EDGES);
  const selfCycleFiles = new Set(
    graph.edges.filter((edge) => edge.sourceId === edge.targetId).map((edge) => edge.sourceId),
  );
  const components = getStronglyConnectedComponents(graph).filter(
    (component) => component.length > 1 || selfCycleFiles.has(component[0]!.id),
  );
  const cycles = components.map((component) => {
    const memberIds = component.map(({ id }) => id);
    const componentGraph = getSubgraph(graph, memberIds);
    const firstEdgeByFile = new Map<string, (typeof graph.edges)[number]>();
    for (const edge of componentGraph.edges) {
      if (!firstEdgeByFile.has(edge.sourceId)) firstEdgeByFile.set(edge.sourceId, edge);
    }
    // Inside an SCC every file has an outgoing edge. DFS finds its first back edge before
    // backtracking, so following only the first outgoing edge preserves the reported cycle.
    const firstEdgeGraph = createGraph({
      nodes: componentGraph.nodes,
      edges: [...firstEdgeByFile.values()],
    });
    const path = [...genDFS(firstEdgeGraph, [...memberIds].sort()[0]!)].map(({ id }) => id);
    const target = firstEdgeByFile.get(path.at(-1)!)!.targetId;
    return [...path.slice(path.indexOf(target)), target];
  });

  return cycles.sort((left, right) => left[0]!.localeCompare(right[0]!));
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
// they are ratcheted rather than merely reported against the merge-base with origin/main: see
// `typeInversionCounts` and scripts/layering/type-inversion-ratchet.ts.
export function typeInversionPair(edge: ResolvedImportEdge): string | null {
  if (edge.dynamic || !edge.typeOnly) return null;
  return spineInversionPair(edge);
}

/**
 * R6's measurement: distinct type-only spine inversions per zone pair, keyed `from -> to` and
 * sorted by pair. The ratchet compares this record across two trees, so it is a pure function of
 * the edge set rather than a count taken inside the rule.
 */
export function typeInversionCounts(
  edges: readonly ResolvedImportEdge[],
): Readonly<Record<string, number>> {
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const edge of edges) {
    const pair = typeInversionPair(edge);
    if (!pair) continue;
    const identity = `${edge.file} -> ${edge.target}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
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
  return getStronglyConnectedComponents(importGraphFromResolvedEdges(edges, STATIC_EDGES))
    .reduce<string[]>((largest, component) => {
      if (component.length > largest.length) largest = component.map(({ id }) => id);
      return largest;
    }, [])
    .sort();
}
