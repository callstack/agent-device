// Component metrics for the repo-health snapshot (#1423): instability, abstractness, and
// main-sequence distance derived from the dependency graph's fan-in/fan-out.
//
// These are OBSERVATORY DATA ONLY. They locate concrete, high-fan-in modules worth pinning harder;
// they must NEVER become CI thresholds (CONTEXT.md "Principles and their gates"). Kept in their own
// module so that constraint — and the approximations these metrics make — stays visible instead of
// blending into the analyzer adapters that feed the gate-adjacent numbers.

import { zoneRank } from '../layering/model.ts';
import type { GraphData } from '../depgraph/model.ts';

export type ZoneComponent = {
  zone: string;
  rank: number | null;
  classification: string;
  files: number;
  loc: number;
  /** Afferent couplings: cross-zone edges INTO the zone (how much depends on it). */
  afferent: number;
  /** Efferent couplings: cross-zone edges OUT of the zone (how much it depends on). */
  efferent: number;
  /** Instability I = efferent / (afferent + efferent); 0 when the zone has no cross-zone edges. */
  instability: number;
  /**
   * Abstractness A, approximated by the type-only share of afferent edges (first approximation
   * per the issue). 0 when nothing depends on the zone.
   */
  abstractness: number;
  /** Distance from the main sequence, |A + I - 1|. Lower is "more balanced". */
  distance: number;
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function zoneMapOf(graph: GraphData): Map<string, string> {
  return new Map(graph.nodes.map((node) => [node.id, node.zone]));
}

/**
 * Per-zone instability / abstractness / main-sequence distance from the graph's cross-zone edges.
 * Observatory data — never a CI threshold.
 */
export function zoneComponents(graph: GraphData): ZoneComponent[] {
  const zoneOf = zoneMapOf(graph);
  const afferent = new Map<string, number>();
  const efferent = new Map<string, number>();
  const typeAfferent = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string): void =>
    map.set(key, (map.get(key) ?? 0) + 1);

  for (const edge of graph.edges) {
    const from = zoneOf.get(edge.from);
    const to = zoneOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    bump(efferent, from);
    bump(afferent, to);
    if (edge.kind === 'type') bump(typeAfferent, to);
  }

  return graph.zones
    .map((zone) => {
      const ca = afferent.get(zone.id) ?? 0;
      const ce = efferent.get(zone.id) ?? 0;
      const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
      const abstractness = ca === 0 ? 0 : (typeAfferent.get(zone.id) ?? 0) / ca;
      return {
        zone: zone.id,
        rank: zoneRank(zone.id),
        classification: zone.classification,
        files: zone.files,
        loc: zone.loc,
        afferent: ca,
        efferent: ce,
        instability: round(instability),
        abstractness: round(abstractness),
        distance: round(Math.abs(abstractness + instability - 1)),
      };
    })
    .sort((left, right) => right.afferent - left.afferent);
}

export type MainSequenceModule = {
  file: string;
  zone: string;
  fanIn: number;
  fanOut: number;
  instability: number;
  abstractness: number;
  distance: number;
  concrete: boolean;
};

/**
 * The main-sequence report: concrete, high-fan-in modules worth pinning harder. Per-file
 * abstractness is approximated by the module's type-only dependent share; a module most of whose
 * dependents import it for VALUES (e.g. src/utils/exec.ts, src/daemon/ref-frame.ts) is concrete
 * and, when its fan-in is high, a foundation the tree leans on. Observatory data only.
 */
export function mainSequenceModules(
  graph: GraphData,
  options: { minFanIn?: number; limit?: number } = {},
): MainSequenceModule[] {
  const minFanIn = options.minFanIn ?? 10;
  const limit = options.limit ?? 40;
  const typeIn = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === 'type') typeIn.set(edge.to, (typeIn.get(edge.to) ?? 0) + 1);
  }

  return graph.nodes
    .filter((node) => node.fanIn >= minFanIn)
    .map((node) => {
      const abstractness = node.fanIn === 0 ? 0 : (typeIn.get(node.id) ?? 0) / node.fanIn;
      const total = node.fanIn + node.fanOut;
      const instability = total === 0 ? 0 : node.fanOut / total;
      return {
        file: node.id.replace(/^src\//, ''),
        zone: node.zone,
        fanIn: node.fanIn,
        fanOut: node.fanOut,
        instability: round(instability),
        abstractness: round(abstractness),
        distance: round(Math.abs(abstractness + instability - 1)),
        concrete: abstractness < 0.5,
      };
    })
    .filter((module) => module.concrete)
    .sort((left, right) => right.fanIn - left.fanIn)
    .slice(0, limit);
}
