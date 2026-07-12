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

export type BackEdgeMap = Record<string, string[]>;

// The ranked target spine. Back-edge detection is defined ONLY between two ranked
// zones: an edge whose source outranks its target (lower number imports higher) is a
// spine back-edge. Zones NOT in this map are intentionally unranked (see
// `UNRANKED_ZONES`); the gate does not rank them, so ranking their edges would claim a
// back-edge guarantee the code does not make. Every production zone must be either
// ranked here or listed as unranked — `unclassifiedZones` and `model.test.ts` guard
// that no zone is silently unclassified.
const TARGET_DAG_RANK = new Map([
  ['kernel', 0],
  ['contracts', 1],
  ['request', 1],
  ['selectors', 1],
  ['platforms', 1],
  ['core', 2],
  ['commands', 3],
  ['cli-schema', 3],
  ['client', 4],
  ['daemon-server', 4],
  ['daemon-client', 5],
  ['cli', 6],
]);

export const RANKED_ZONES: ReadonlySet<string> = new Set(TARGET_DAG_RANK.keys());

// Zones deliberately left OUT of the ranked spine. They are NOT unenforced: every file
// in them is still subject to the global production value-import cycle rejection (R4)
// and the R1-R3 move rules. They only opt out of spine back-edge ranking, for one of
// two deliberate reasons:
//   - root: `(root)` entrypoints (src/cli.ts, src/backend.ts, …) compose the spine from
//     above rather than sitting inside it.
//   - peripheral: satellite feature/adapter zones the spine does not depend on in a
//     fixed rank order. Assigning them a rank would invent a back-edge direction the
//     architecture does not commit to.
export const UNRANKED_ZONES: ReadonlySet<string> = new Set([
  '(root)',
  'cloud-webdriver',
  'compat',
  'mcp',
  'metro',
  'recording',
  'remote',
  'replay',
  'screenshot-diff',
  'sdk',
  'snapshot',
  'utils',
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
): string | null {
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

export function resolveImportEdges(sources: ReadonlyMap<string, string>): ResolvedImportEdge[] {
  const sourceFiles = new Set(sources.keys());
  const edges: ResolvedImportEdge[] = [];
  for (const [file, source] of sources) {
    for (const edge of parseImports(source)) {
      const target = resolveTargetFile(file, edge.spec, sourceFiles);
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

export function backEdgePair(edge: ResolvedImportEdge): string | null {
  if (edge.dynamic || edge.typeOnly || edge.fromZone === edge.toZone) return null;
  const fromRank = TARGET_DAG_RANK.get(edge.fromZone);
  const toRank = TARGET_DAG_RANK.get(edge.toZone);
  if (fromRank === undefined || toRank === undefined || fromRank >= toRank) return null;
  return `${edge.fromZone} -> ${edge.toZone}`;
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
