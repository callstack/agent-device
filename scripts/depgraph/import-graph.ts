// The collapsed import edges as a `@statelyai/graph` graph, filtered to the edge kinds one
// question cares about. Every traversal in the depgraph report and the `affected` query runs on
// a graph built here, so a kind filter is the only thing that distinguishes their subgraphs.

import { createGraph, type Graph } from '@statelyai/graph';

export type EdgeKind = 'value' | 'type' | 'dynamic';

/** The subgraph R4 keeps acyclic: what a module needs before it can evaluate. */
export const VALUE_EDGES: ReadonlySet<EdgeKind> = new Set(['value']);

/**
 * What a module can actually run: value imports plus dynamic ones. The daemon loads every
 * command handler through `import()` (`src/daemon/request-handler-chain.ts`), so dropping
 * dynamic edges would cut every handler chain at its root.
 */
export const EXECUTABLE_EDGES: ReadonlySet<EdgeKind> = new Set(['value', 'dynamic']);
export const STATIC_EDGES: ReadonlySet<EdgeKind> = new Set(['value', 'type']);

/**
 * Every collapsed edge kind, for the structural question ("does anything reference this file at
 * all") community detection asks (`computeCohesionSummary`). Community algorithms treat the graph
 * as undirected regardless of kind, so mixing kinds in is the right input, not a loosening of a
 * rule — there is no gate riding on this set. Zone-level cycle reporting (`computeZoneSccSummary`)
 * does not use this set: it builds its own zone graph from VALUE zone pairs only, to mirror R4.
 */
export const ALL_EDGES: ReadonlySet<EdgeKind> = new Set(['value', 'type', 'dynamic']);

type ImportGraphEdge = { from: string; to: string; kind: EdgeKind };

type ResolvedGraphEdge = {
  file: string;
  target: string;
  dynamic: boolean;
  typeOnly: boolean;
};

/**
 * Identity of one file pair, shared by `collapseEdges` and the graph's edge ids. NUL cannot occur
 * in a file path, so distinct pairs never share an id.
 */
export function importEdgeId(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/**
 * One node per file that appears on either side of a kept edge, plus any `files` passed in, so
 * isolated modules still exist as nodes.
 */
export function importGraph(
  edges: readonly ImportGraphEdge[],
  kinds: ReadonlySet<EdgeKind>,
  files: Iterable<string> = [],
): Graph {
  const kept = edges.filter((edge) => kinds.has(edge.kind));
  const ids = new Set(files);
  for (const edge of kept) {
    ids.add(edge.from);
    ids.add(edge.to);
  }
  return createGraph({
    nodes: [...ids].map((id) => ({ id })),
    edges: kept.map((edge) => ({
      id: importEdgeId(edge.from, edge.to),
      sourceId: edge.from,
      targetId: edge.to,
    })),
  });
}

/** Build a traversal graph from the normalized edges produced by the layering model. */
export function importGraphFromResolvedEdges(
  edges: readonly ResolvedGraphEdge[],
  kinds: ReadonlySet<EdgeKind>,
  files: Iterable<string> = [],
): Graph {
  const seen = new Set<string>();
  const graphEdges: ImportGraphEdge[] = [];
  for (const edge of edges) {
    const kind: EdgeKind = edge.dynamic ? 'dynamic' : edge.typeOnly ? 'type' : 'value';
    if (!kinds.has(kind)) continue;
    const id = importEdgeId(edge.file, edge.target);
    if (seen.has(id)) continue;
    seen.add(id);
    graphEdges.push({ from: edge.file, to: edge.target, kind });
  }
  return importGraph(graphEdges, kinds, files);
}
