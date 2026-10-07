// Report-only structural summaries the layering gate does not compute: the dominator tree of one
// entry's eager-load closure, zone-level strongly connected components, and community detection
// against declared zones. Pure functions over `GraphData`; nothing here feeds
// `scripts/layering/` or `scripts/check-affected/`, and no gate reads these fields.

import {
  createGraph,
  getDominatorTree,
  getLouvainCommunities,
  getModularity,
  getStronglyConnectedComponents,
  type Graph,
  type GraphNode as LibGraphNode,
} from '@statelyai/graph';
import { ALL_EDGES, importGraph, VALUE_EDGES } from './import-graph.ts';
import type { GraphData } from './model.ts';

export type DominatorBottleneck = {
  file: string;
  /** Files, `file` included, that become unreachable from the entry if `file` is removed. */
  files: number;
  loc: number;
};

export type DominatorSummary = {
  entry: string;
  reachableFiles: number;
  reachableLoc: number;
  totalFiles: number;
  /** Non-entry nodes ranked by dominated subtree size, largest first. */
  bottlenecks: DominatorBottleneck[];
};

/**
 * Dominator tree of `entry`'s eager-load closure over VALUE edges only — the files loaded before
 * `entry` finishes evaluating. Dynamic imports are a deliberate cold-start seam (see
 * `import-graph.ts`), so they are excluded on purpose: this answers "what does loading `entry`
 * actually pull in", not "what can `entry` eventually reach".
 *
 * A node's dominated subtree is every file that would stop being reachable from `entry` if that
 * node disappeared — the size of the branch moving it behind `import()` would cut. Nodes not
 * reachable from `entry` are absent from `getDominatorTree`'s result by construction (it walks
 * from `from` and only records visited nodes), so `reachableFiles` is exactly that closure size.
 */
export function computeDominatorSummary(entry: string, graph: GraphData): DominatorSummary {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  if (!nodesById.has(entry)) {
    throw new Error(`${entry} is not a production source file in the layering graph.`);
  }

  const valueGraph = importGraph(graph.edges, VALUE_EDGES, [entry]);
  const idom = getDominatorTree(valueGraph, { from: entry });
  const reachable = Object.keys(idom);

  const children = new Map<string, string[]>();
  for (const [id, parent] of Object.entries(idom)) {
    if (parent === null) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(id);
    children.set(parent, siblings);
  }

  const subtreeSizes = new Map<string, { files: number; loc: number }>();
  const sizeOf = (id: string): { files: number; loc: number } => {
    const cached = subtreeSizes.get(id);
    if (cached) return cached;
    let files = 1;
    let loc = nodesById.get(id)?.loc ?? 0;
    for (const child of children.get(id) ?? []) {
      const childSize = sizeOf(child);
      files += childSize.files;
      loc += childSize.loc;
    }
    const size = { files, loc };
    subtreeSizes.set(id, size);
    return size;
  };
  for (const id of reachable) sizeOf(id);

  const bottlenecks = reachable
    .filter((id) => id !== entry)
    .map((file) => ({ file, ...sizeOf(file) }))
    .sort((left, right) => right.files - left.files || left.file.localeCompare(right.file));

  return {
    entry,
    reachableFiles: reachable.length,
    reachableLoc: sizeOf(entry).loc,
    totalFiles: graph.nodes.length,
    bottlenecks,
  };
}

export type ZoneComponent = { zones: string[]; size: number };

export type ZoneSccSummary = {
  zones: number;
  /** Zone groups tied together by a cycle, largest first. Singleton zones are not components. */
  components: ZoneComponent[];
};

/**
 * Strongly connected components of the zone graph, built from VALUE zone pairs only (`zoneEdges`
 * entries with `valueCount > 0`) — the same edge kind R4 keeps acyclic at file level. R4 is a
 * file-level guarantee; nothing stops a loop from closing once files collapse into zones, which
 * is exactly the guardrail gap workstream 4 of #3276 names. This reports what currently cycles at
 * zone level; it enforces nothing.
 */
export function computeZoneSccSummary(graph: GraphData): ZoneSccSummary {
  const zoneIds = graph.zones.map((zone) => zone.id);
  const valueZoneEdges = graph.zoneEdges.filter((edge) => edge.valueCount > 0);
  const zoneGraph: Graph = createGraph({
    nodes: zoneIds.map((id) => ({ id })),
    edges: valueZoneEdges.map((edge, index) => ({
      id: `${edge.from}\u0000${edge.to}\u0000${index}`,
      sourceId: edge.from,
      targetId: edge.to,
    })),
  });

  const components = getStronglyConnectedComponents(zoneGraph)
    .map((component) => ({
      zones: component.map((node) => node.id).sort(),
      size: component.length,
    }))
    .filter((component) => component.size > 1)
    .sort((left, right) => right.size - left.size || left.zones[0]!.localeCompare(right.zones[0]!));

  return { zones: zoneIds.length, components };
}

export type ZoneCohesion = {
  zone: string;
  files: number;
  largestCommunitySize: number;
  /** Share of the zone's files that land in its largest detected community. */
  cohesionShare: number;
};

export type CohesionSummary = {
  modularity: { declaredZones: number; detectedCommunities: number };
  /** Least cohesive zone first. */
  zoneCohesion: ZoneCohesion[];
};

/**
 * `getModularity` wants `Community<N>` — full node objects from the graph being measured — but
 * `getLouvainCommunities` returns bare ids. Mapping ids back to the graph's own node objects is
 * the workaround; see the upstream issue filed for this gap (scripts/depgraph/README.md).
 */
function toCommunities(graph: Graph, idGroups: readonly string[][]): LibGraphNode[][] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  return idGroups.map((ids) => ids.map((id) => nodesById.get(id)!));
}

/**
 * Louvain communities vs. declared zones, and per-zone cohesion against the detected partition.
 * Community detection treats the graph as undirected regardless of edge kind, so the comparison
 * graph mixes value, type-only, and dynamic edges: the question is "does anything reference this
 * file at all", not evaluation order.
 */
export function computeCohesionSummary(graph: GraphData): CohesionSummary {
  const fullGraph = importGraph(
    graph.edges,
    ALL_EDGES,
    graph.nodes.map((node) => node.id),
  );
  const detected = getLouvainCommunities(fullGraph);

  const filesByZone = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const files = filesByZone.get(node.zone) ?? [];
    files.push(node.id);
    filesByZone.set(node.zone, files);
  }
  const declaredZones = [...filesByZone.values()];

  const modularity = {
    declaredZones: getModularity(fullGraph, toCommunities(fullGraph, declaredZones)),
    detectedCommunities: getModularity(fullGraph, toCommunities(fullGraph, detected)),
  };

  const communityIndexByFile = new Map<string, number>();
  detected.forEach((group, index) => {
    for (const file of group) communityIndexByFile.set(file, index);
  });

  const zoneCohesion = [...filesByZone.entries()]
    .map(([zone, files]) => {
      const counts = new Map<number, number>();
      for (const file of files) {
        const community = communityIndexByFile.get(file)!;
        counts.set(community, (counts.get(community) ?? 0) + 1);
      }
      const largestCommunitySize = Math.max(...counts.values());
      return {
        zone,
        files: files.length,
        largestCommunitySize,
        cohesionShare: largestCommunitySize / files.length,
      };
    })
    .sort(
      (left, right) =>
        left.cohesionShare - right.cohesionShare || left.zone.localeCompare(right.zone),
    );

  return { modularity, zoneCohesion };
}
