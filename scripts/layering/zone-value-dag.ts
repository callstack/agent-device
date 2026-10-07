import { findValueImportCycles, type LayeringViolation, type ResolvedImportEdge } from './model.ts';

export const ZONE_VALUE_DAG_RULE = 'R80 zone-value-dag';

/**
 * Cycles in the zone graph of static value imports, each a closed zone path. Imports inside one
 * zone are dropped first: they are R4's subject, and a zone does not form a cycle with itself.
 */
export function zoneValueCycles(edges: readonly ResolvedImportEdge[]): string[][] {
  return findValueImportCycles(
    edges
      .filter((edge) => edge.fromZone !== edge.toZone)
      .map((edge) => ({ ...edge, file: edge.fromZone, target: edge.toZone })),
  );
}

/**
 * Catches: two zones value-importing each other through files that never close a file-level
 *   cycle — invisible to R4, and to R5 when both zones share a rank, since R5 only orders zones of
 *   different ranks.
 * Evidence: #3280 measured nine zones in one cycle, every closing edge through the then-unranked
 *   `(root)`, plus the same-rank `remote ⇄ daemon-server` pair.
 * Cost: 103 LOC (57 rule + 46 test); one projection of the edge set onto zones through R4's
 *   cycle finder.
 * Kill criterion: zones stop being the unit of layering, or R5 orders every zone pair strictly.
 *   Dynamic imports stay out for the reason recorded at R5 in check.ts.
 */
export function checkZoneValueDag(edges: readonly ResolvedImportEdge[]): LayeringViolation[] {
  const witnessByPair = new Map<string, ResolvedImportEdge>();
  for (const edge of edges) {
    if (edge.dynamic || edge.typeOnly || edge.fromZone === edge.toZone) continue;
    const pair = `${edge.fromZone} -> ${edge.toZone}`;
    const witness = witnessByPair.get(pair);
    if (!witness || identity(edge).localeCompare(identity(witness)) < 0) {
      witnessByPair.set(pair, edge);
    }
  }
  return zoneValueCycles(edges).map((cycle) => {
    const hops = cycle.slice(1).map((zone, index) => {
      const pair = `${cycle[index]} -> ${zone}`;
      return { pair, witness: witnessByPair.get(pair)! };
    });
    return {
      rule: ZONE_VALUE_DAG_RULE,
      file: hops[0]!.witness.file,
      line: hops[0]!.witness.line,
      message:
        `zone-level value-import cycle: ${cycle.join(' -> ')} ` +
        `(${hops.map(({ pair, witness }) => `${pair}: ${identity(witness)}`).join('; ')}). ` +
        'Move the contract both zones read below both of them.',
    };
  });
}

function identity(edge: ResolvedImportEdge): string {
  return `${edge.file} -> ${edge.target}`;
}
