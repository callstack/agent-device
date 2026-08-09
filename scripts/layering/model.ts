import path from 'node:path';

export type ImportEdge = {
  spec: string;
  dynamic: boolean;
  typeOnly: boolean;
  line: number;
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
  ['platforms', 1],
  ['recording', 1],
  ['replay', 1],
  ['replay-test', 1],
  ['request', 1],
  ['screenshot-diff', 1],
  ['selectors', 1],
  ['snapshot', 1],
  ['utils', 1],
  ['core', 2],
  ['cli-schema', 3],
  ['commands', 3],
  ['mcp', 3],
  ['client', 4],
  ['compat', 4],
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
// invent an order the architecture had not committed to. Once `utils` joined the spine and
// `(root)` was emptied of shared contracts, every one of them turned out to have a
// consistent rank already — so the order was there, just unasserted.
// Extracted workspace packages are not src/ zones: R11 owns their physical seams, and their zone
// names only appear in workspace-aware graphs. The platform packages additionally carry R13's
// exact-family/composition/laziness policy.
export const UNRANKED_ZONES: ReadonlySet<string> = new Set([
  '(root)',
  'kernel',
  'platform-apple',
  'platform-android',
  'platform-harmonyos',
  'platform-vega',
  'platform-linux',
  'platform-web',
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

function scanDynamicImports(line: string, lineNo: number): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const re = /import\s*\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line))) {
    edges.push({ spec: match[1]!, dynamic: true, typeOnly: false, line: lineNo });
  }
  return edges;
}

function scanSideEffectImport(line: string, lineNo: number): ImportEdge | null {
  const match = /^\s*import\s+['"]([^'"]+)['"]/.exec(line);
  return match ? { spec: match[1]!, dynamic: false, typeOnly: false, line: lineNo } : null;
}

function statementIsTypeOnly(statement: string): boolean {
  if (/^\s*(?:import|export)\s+type\b/.test(statement)) return true;
  const named = /\{([\s\S]*?)\}/.exec(statement);
  if (!named) return false;
  const prefix = statement
    .slice(0, named.index)
    .replace(/^\s*(?:import|export)\s+/, '')
    .trim()
    .replace(/,$/, '')
    .trim();
  if (prefix.length > 0) return false;
  const specifiers = named[1]!
    .split(',')
    .map((specifier) => specifier.trim())
    .filter(Boolean);
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\b/.test(specifier));
}

function scanFromImport(lines: string[], index: number): ImportEdge | null {
  const fromMatch = /(?:^|[\s;}])from\s+['"]([^'"]+)['"]/.exec(lines[index]!);
  if (!fromMatch) return null;

  let start = index;
  while (start >= 0 && !/^\s*(?:import|export)\b/.test(lines[start]!)) start--;
  if (start < 0) return null;

  const statement = lines.slice(start, index + 1).join('\n');
  return {
    spec: fromMatch[1]!,
    dynamic: false,
    typeOnly: statementIsTypeOnly(statement),
    line: start + 1,
  };
}

export function parseImports(source: string): ImportEdge[] {
  const lines = source.split('\n');
  const edges: ImportEdge[] = [];
  for (let index = 0; index < lines.length; index++) {
    edges.push(...scanDynamicImports(lines[index]!, index + 1));
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
  if (!resolved.startsWith('src/')) return null;
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
