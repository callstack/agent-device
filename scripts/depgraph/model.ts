// Dependency-graph analysis model — pure functions over the layering gate's edge model.
//
// The graph is deliberately derived from `scripts/layering/model.ts` rather than a
// third-party extractor: the gate's file set (production `src/**/*.ts`, tests excluded),
// zone partition, edge kinds (value/type-only/dynamic), and cycle definition are already
// the repo's source of truth. A second extractor with its own resolution rules would
// visualize a graph the gate does not enforce.

import {
  backEdgePair,
  classifyZone,
  findValueImportCycles,
  targetDagZone,
  typeInversionPair,
  type ResolvedImportEdge,
} from '../layering/model.ts';
import { ARCHITECTURE_OWNERSHIP, matchesDeclaredRoot } from '../layering/architecture-ownership.ts';
import { genPostorder, getSuccessors, getTransitiveReduction } from '@statelyai/graph';
import { importEdgeId, importGraph, VALUE_EDGES } from './import-graph.ts';

export type EdgeKind = 'value' | 'type' | 'dynamic';

export const AUTHORITY_LABELS = [
  'vocabulary',
  'capability',
  'live-state-shape',
  'live-state-authority',
  'executable-policy',
  'ordinary',
] as const;

export type AuthorityLabel = (typeof AUTHORITY_LABELS)[number];
export type AuthorityCounts = Record<AuthorityLabel, number>;
type DeclaredAuthorityLabel = Exclude<AuthorityLabel, 'ordinary'>;

type AuthorityRule = Readonly<{
  label: DeclaredAuthorityLabel;
  side: 'source' | 'target';
  roots: readonly string[];
  symbols?: readonly string[];
}>;

const AUTHORITY_RULES: readonly AuthorityRule[] = [
  ...ARCHITECTURE_OWNERSHIP.vocabulary.map(({ kind, roots }): AuthorityRule => ({
    label: kind,
    side: 'target',
    roots,
  })),
  ...ARCHITECTURE_OWNERSHIP.capabilities.map(({ kind, root, exports }): AuthorityRule => ({
    label: kind,
    side: 'target',
    roots: [root],
    symbols: exports,
  })),
  ...ARCHITECTURE_OWNERSHIP.liveState.map(({ kind, root, exports }): AuthorityRule => ({
    label: kind,
    side: 'target',
    roots: [root],
    symbols: exports,
  })),
  ...ARCHITECTURE_OWNERSHIP.executablePolicies.map(({ kind, roots }): AuthorityRule => ({
    label: kind,
    side: 'source',
    roots,
  })),
];

export type GraphEdge = {
  from: string;
  to: string;
  kind: EdgeKind;
  line: number;
  /** Set when this edge is a ranked-spine back-edge (`R5`), as `from-zone -> to-zone`. */
  backEdge: string | null;
  /** Set when this edge is a type-only spine inversion (`R6`), as `from-zone -> to-zone`. */
  typeInversion: string | null;
  /** Target also reachable at distance >= 2. Reachability only — see the marker function. */
  transitivelyReachable: boolean;
  /** Declared labels accumulated from every raw import in this collapsed pair. */
  authorities: readonly DeclaredAuthorityLabel[];
};

export type GraphNode = {
  id: string;
  zone: string;
  /** First two path segments — a finer cluster than the zone, used for layout gravity. */
  loc: number;
  fanIn: number;
  fanOut: number;
  /** Index into `GraphData.cycles`, or -1. */
  cycle: number;
};

export type ZoneEdge = {
  from: string;
  to: string;
  count: number;
  valueCount: number;
  backEdge: boolean;
};

export type GraphCycle = {
  path: string[];
  /** `value` cycles are gate-rejected (R4); the others are gate-invisible by design. */
  kind: EdgeKind;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  edgeAuthorities: AuthorityLabel[][];
  authorityCounts: AuthorityCounts;
  zones: { id: string; classification: string; files: number; loc: number }[];
  zoneEdges: ZoneEdge[];
  cycles: GraphCycle[];
  /** Type-only spine inversions per zone pair, counted by the gate's rule. */
  typeInversions: Record<string, number>;
};

function orderedDeclaredAuthorities(
  labels: Iterable<DeclaredAuthorityLabel>,
): DeclaredAuthorityLabel[] {
  const selected = new Set(labels);
  return AUTHORITY_LABELS.filter(
    (label): label is DeclaredAuthorityLabel => label !== 'ordinary' && selected.has(label),
  );
}

function declaredAuthorities(edge: ResolvedImportEdge): DeclaredAuthorityLabel[] {
  const labels = new Set<DeclaredAuthorityLabel>();
  for (const rule of AUTHORITY_RULES) {
    const subject = rule.side === 'source' ? edge.file : edge.target;
    if (!rule.roots.some((root) => matchesDeclaredRoot(subject, root))) continue;
    if (rule.symbols && !edge.symbols.some((symbol) => rule.symbols.includes(symbol))) continue;
    labels.add(rule.label);
  }
  return orderedDeclaredAuthorities(labels);
}

function authorityLabelsForDeclared(
  authorities: readonly DeclaredAuthorityLabel[],
): AuthorityLabel[] {
  return authorities.length > 0 ? [...authorities] : ['ordinary'];
}

/** Labels one resolved edge from exact declared roots and symbols. */
export function authorityLabelsForEdge(edge: ResolvedImportEdge): AuthorityLabel[] {
  return authorityLabelsForDeclared(declaredAuthorities(edge));
}

function countAuthorityLabels(edgeAuthorities: readonly AuthorityLabel[][]): AuthorityCounts {
  const counts = Object.fromEntries(AUTHORITY_LABELS.map((label) => [label, 0])) as AuthorityCounts;
  for (const labels of edgeAuthorities) {
    for (const label of labels) counts[label]++;
  }
  return counts;
}

function countLines(source: string): number {
  let lines = 1;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') lines++;
  }
  return lines;
}

function edgeKind(edge: ResolvedImportEdge): EdgeKind {
  if (edge.dynamic) return 'dynamic';
  if (edge.typeOnly) return 'type';
  return 'value';
}

/**
 * Deduplicate parsed import edges down to one edge per (from, to) pair, keeping the
 * strongest kind. A file that imports both a type and a value from the same module has one
 * dependency on it, and the value import is what constrains layering and cold-start.
 */
export function collapseEdges(edges: readonly ResolvedImportEdge[]): GraphEdge[] {
  const strength: Record<EdgeKind, number> = { type: 0, dynamic: 1, value: 2 };
  const byPair = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (edge.file === edge.target) continue;
    const key = importEdgeId(edge.file, edge.target);
    const kind = edgeKind(edge);
    const existing = byPair.get(key);
    const authorities = orderedDeclaredAuthorities([
      ...(existing?.authorities ?? []),
      ...declaredAuthorities(edge),
    ]);
    if (existing && strength[existing.kind] >= strength[kind]) {
      byPair.set(key, { ...existing, authorities });
      continue;
    }
    byPair.set(key, {
      from: edge.file,
      to: edge.target,
      kind,
      line: edge.line,
      backEdge: backEdgePair(edge),
      typeInversion: typeInversionPair(edge),
      transitivelyReachable: false,
      authorities,
    });
  }
  return [...byPair.values()].sort(
    (left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

/**
 * Flag value edges whose target is ALSO reachable from the source at distance >= 2.
 *
 * This is static module reachability and nothing more. It is emphatically NOT a removability
 * claim, and the difference matters because the obvious reading is wrong:
 *
 * - Reachability does not carry BINDINGS. If `a` does `import { c } from './c'` while `b` only
 *   re-exports it under another name (`export { c as b } from './c'`), the path `a -> b -> c`
 *   exists and deleting `a -> c` still breaks `a`. The fixture in model.test.ts is exactly this
 *   shape.
 * - It does not preserve EVALUATION. A module's side effects run when it is first imported;
 *   dropping a direct edge can change when, or whether from `a`'s perspective, that happens.
 * - It says nothing about re-export chains being intentional. A direct import is frequently
 *   clearer than reaching through a barrel.
 *
 * So the output is a place to look, not a work list — and at ~2300 edges, a large one. Deciding
 * whether any given edge can go needs symbol-level analysis this does not attempt.
 *
 * On a DAG, the edges with a longer alternative path are exactly the ones the transitive
 * reduction drops. The reduction is undefined on a cycle, so callers mark only when the graph has
 * no `value` cycle (R4); the library throws otherwise.
 */
export function markTransitivelyReachableEdges(edges: GraphEdge[]): void {
  const valueGraph = importGraph(edges, VALUE_EDGES);
  const kept = new Set(getTransitiveReduction(valueGraph).edges.map((edge) => edge.id));
  for (const edge of edges) {
    if (edge.kind !== 'value') continue;
    edge.transitivelyReachable = !kept.has(importEdgeId(edge.from, edge.to));
  }
}

/**
 * Cycles over an edge subset that includes weaker edge kinds. `findValueImportCycles`
 * covers the gate's R4 scope (static value edges); passing type-only and dynamic edges
 * through the same detector surfaces the cycles the gate deliberately does not reject —
 * still design signal, because a type-only cycle means two modules co-define one contract.
 */
export function collectCycles(edges: readonly ResolvedImportEdge[]): GraphCycle[] {
  const asValue = (subset: readonly ResolvedImportEdge[]): ResolvedImportEdge[] =>
    subset.map((edge) => ({ ...edge, dynamic: false, typeOnly: false }));

  const valuePaths = findValueImportCycles(edges);
  const valueKeys = new Set(valuePaths.map(cycleKey));
  const cycles: GraphCycle[] = valuePaths.map((path) => ({ path, kind: 'value' }));

  const staticEdges = edges.filter((edge) => !edge.dynamic);
  for (const path of findValueImportCycles(asValue(staticEdges))) {
    if (valueKeys.has(cycleKey(path))) continue;
    valueKeys.add(cycleKey(path));
    cycles.push({ path, kind: 'type' });
  }

  for (const path of findValueImportCycles(asValue(edges))) {
    if (valueKeys.has(cycleKey(path))) continue;
    valueKeys.add(cycleKey(path));
    cycles.push({ path, kind: 'dynamic' });
  }

  return cycles;
}

/** Rotation-independent identity for a cycle path, so the same loop is not reported twice. */
function cycleKey(path: readonly string[]): string {
  const members = [...new Set(path)].sort();
  return members.join('\u0000');
}

/** First cycle each file belongs to, so a node can point at its loop in one lookup. */
function indexCyclesByFile(cycles: readonly GraphCycle[]): Map<string, number> {
  const cycleByFile = new Map<string, number>();
  for (let index = 0; index < cycles.length; index++) {
    for (const file of cycles[index]!.path) {
      if (!cycleByFile.has(file)) cycleByFile.set(file, index);
    }
  }
  return cycleByFile;
}

/** One node per production file, with degrees accumulated from the collapsed edge list. */
function buildNodes(
  sources: ReadonlyMap<string, string>,
  edges: readonly GraphEdge[],
  cycleByFile: ReadonlyMap<string, number>,
): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const [file, source] of sources) {
    nodes.set(file, {
      id: file,
      zone: targetDagZone(file),
      loc: countLines(source),
      fanIn: 0,
      fanOut: 0,
      cycle: cycleByFile.get(file) ?? -1,
    });
  }
  for (const edge of edges) {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from) from.fanOut++;
    if (to) to.fanIn++;
  }
  return nodes;
}

/** Busiest pair first, then alphabetical, so the output is stable across runs. */
function compareZoneEdges(left: ZoneEdge, right: ZoneEdge): number {
  return (
    right.count - left.count ||
    left.from.localeCompare(right.from) ||
    left.to.localeCompare(right.to)
  );
}

/** The zone pair an edge crosses, or `null` when it stays inside one zone. */
function crossedZonePair(
  nodes: ReadonlyMap<string, GraphNode>,
  edge: GraphEdge,
): { from: string; to: string } | null {
  const from = nodes.get(edge.from)?.zone;
  const to = nodes.get(edge.to)?.zone;
  if (from === undefined || to === undefined || from === to) return null;
  return { from, to };
}

/** Cross-zone traffic, one entry per ordered zone pair. Same-zone edges are not boundary edges. */
function aggregateZoneEdges(
  nodes: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
): ZoneEdge[] {
  const zoneEdges = new Map<string, ZoneEdge>();
  for (const edge of edges) {
    const pair = crossedZonePair(nodes, edge);
    if (!pair) continue;
    const key = `${pair.from} ${pair.to}`;
    const entry = zoneEdges.get(key) ?? { ...pair, count: 0, valueCount: 0, backEdge: false };
    entry.count++;
    if (edge.kind === 'value') entry.valueCount++;
    if (edge.backEdge) entry.backEdge = true;
    zoneEdges.set(key, entry);
  }
  return [...zoneEdges.values()].sort(compareZoneEdges);
}

/** Per-zone size, largest first — the "which boundary is big" view. */
function aggregateZones(nodes: ReadonlyMap<string, GraphNode>): GraphData['zones'] {
  const stats = new Map<string, { files: number; loc: number }>();
  for (const node of nodes.values()) {
    const entry = stats.get(node.zone) ?? { files: 0, loc: 0 };
    entry.files++;
    entry.loc += node.loc;
    stats.set(node.zone, entry);
  }
  return [...stats]
    .map(([id, entry]) => ({
      id,
      classification: classifyZone(id),
      files: entry.files,
      loc: entry.loc,
    }))
    .sort((left, right) => right.loc - left.loc);
}

/**
 * Type-only spine inversions per zone pair, counted the way the gate counts them: once per FILE
 * pair, over the raw resolved edges.
 *
 * Deliberately not derived from the collapsed edge list. `collapseEdges` keeps one edge per file
 * pair, strongest kind wins, and `dynamic` outranks `type` — so a module imported both lazily and
 * for its types would collapse to `dynamic` and drop out of the count. No such pair exists today,
 * but the report's inversion count must not drift for a reason unrelated to layering. This is
 * report data only; the layering gate owns and enforces the inversion ratchet.
 */
export function typeInversionsByPair(edges: readonly ResolvedImportEdge[]): Record<string, number> {
  const seen = new Set<string>();
  const byPair = new Map<string, number>();
  for (const edge of edges) {
    const pair = typeInversionPair(edge);
    if (!pair) continue;
    const identity = importEdgeId(edge.file, edge.target);
    if (seen.has(identity)) continue;
    seen.add(identity);
    byPair.set(pair, (byPair.get(pair) ?? 0) + 1);
  }
  return Object.fromEntries([...byPair].sort(([left], [right]) => left.localeCompare(right)));
}

export function buildGraph(
  sources: ReadonlyMap<string, string>,
  edges: readonly ResolvedImportEdge[],
): GraphData {
  const collapsed = collapseEdges(edges);
  const edgeAuthorities = collapsed.map(({ authorities }) =>
    authorityLabelsForDeclared(authorities),
  );
  const cycles = collectCycles(edges);
  const nodes = buildNodes(sources, collapsed, indexCyclesByFile(cycles));

  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: collapsed,
    edgeAuthorities,
    authorityCounts: countAuthorityLabels(edgeAuthorities),
    zones: aggregateZones(nodes),
    zoneEdges: aggregateZoneEdges(nodes, collapsed),
    cycles,
    typeInversions: typeInversionsByPair(edges),
  };
}

/**
 * Longest distance from each node to a sink over value edges. R4 keeps that subgraph a DAG; on a
 * value cycle the edge that closes the loop adds no height, so levels stay finite.
 */
export function computeLevels(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Map<string, number> {
  const ids = nodes.map((node) => node.id);
  const valueGraph = importGraph(edges, VALUE_EDGES, ids);
  const levels = new Map<string, number>();
  for (const node of genPostorder(valueGraph, { from: ids })) {
    let best = 0;
    for (const next of getSuccessors(valueGraph, node.id)) {
      const height = levels.get(next.id);
      if (height !== undefined) best = Math.max(best, height + 1);
    }
    levels.set(node.id, best);
  }
  return levels;
}
