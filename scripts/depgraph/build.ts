// Dependency-graph report — the numbers the layering gate does not enforce.
//
//   node --experimental-strip-types scripts/depgraph/build.ts [--out <path>]
//
// Emits a JSON graph plus a short text summary. It reuses scripts/layering/model.ts, the same
// module check.ts uses in CI, so the file set, zone partition, edge kinds and cycle definition
// are the ones actually enforced — a second extractor would describe a graph nobody gates.
//
// What it adds over `pnpm check:layering`: value edges whose target is also reachable at distance
// >= 2 (module reachability, NOT a removability claim), cycles that are
// deliberately outside R4 (type-only and dynamic), per-zone size, and per-file fan-in/fan-out.
// See README.md for which question each field answers.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { zoneRank } from '../layering/model.ts';
import { runAffected } from './affected-run.ts';
import { loadGraph } from './load.ts';
import { computeLevels, type GraphData } from './model.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Compact wire form. Nodes and edges are index-addressed to keep the payload small. */
type Payload = {
  generated: { commit: string; files: number; edges: number };
  zones: { id: string; rank: number | null; classification: string; files: number; loc: number }[];
  zoneEdges: GraphData['zoneEdges'];
  nodes: {
    id: string;
    z: number;
    loc: number;
    in: number;
    out: number;
    lvl: number;
    cyc: number;
  }[];
  /**
   * `[fromIndex, toIndex, kind, flags]`; kind 0=value 1=type 2=dynamic,
   * flags bit0=R5 back-edge, bit1=target also reachable at distance >= 2, bit2=R6 type inversion.
   */
  edges: [number, number, number, number][];
  cycles: { kind: string; path: number[] }[];
  /** Type-only spine inversions per zone pair, by the gate's counting rule. */
  typeInversions: Record<string, number>;
};

function headCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

const EDGE_KIND_CODES = { value: 0, type: 1, dynamic: 2 } as const;

/** Wire code for an edge kind, so the payload carries a number rather than a string per edge. */
function edgeKindCode(kind: GraphData['edges'][number]['kind']): number {
  return EDGE_KIND_CODES[kind];
}

/**
 * Bitfield: 1 = spine back-edge (R5), 2 = target also reachable at distance >= 2, 4 = type-only
 * inversion (R6). Bit 2 is reachability, NOT removability — see markTransitivelyReachableEdges.
 */
function edgeFlags(edge: GraphData['edges'][number]): number {
  return (
    (edge.backEdge ? 1 : 0) | (edge.transitivelyReachable ? 2 : 0) | (edge.typeInversion ? 4 : 0)
  );
}

function buildPayload(): Payload {
  const graph = loadGraph(repoRoot);
  const levels = computeLevels(graph.nodes, graph.edges);

  const zoneIndex = new Map(graph.zones.map((zone, index) => [zone.id, index]));
  const nodeIndex = new Map(graph.nodes.map((node, index) => [node.id, index]));

  return {
    generated: { commit: headCommit(), files: graph.nodes.length, edges: graph.edges.length },
    zones: graph.zones.map((zone) => ({ ...zone, rank: zoneRank(zone.id) })),
    zoneEdges: graph.zoneEdges,
    nodes: graph.nodes.map((node) => ({
      id: node.id.replace(/^src\//, ''),
      z: zoneIndex.get(node.zone)!,
      loc: node.loc,
      in: node.fanIn,
      out: node.fanOut,
      lvl: levels.get(node.id) ?? 0,
      cyc: node.cycle,
    })),
    edges: graph.edges.map((edge) => [
      nodeIndex.get(edge.from)!,
      nodeIndex.get(edge.to)!,
      edgeKindCode(edge.kind),
      edgeFlags(edge),
    ]),
    cycles: graph.cycles.map((cycle) => ({
      kind: cycle.kind,
      path: cycle.path.map((file) => nodeIndex.get(file)!),
    })),
    typeInversions: graph.typeInversions,
  };
}

async function main(argv: readonly string[]): Promise<number> {
  // `affected` is the query subcommand (scripts/depgraph/affected-run.ts); with no subcommand
  // this stays the whole-graph report.
  if (argv[0] === 'affected') return await runAffected(argv.slice(1), repoRoot);

  const outFlag = argv.indexOf('--out');
  const jsonPath =
    outFlag >= 0 && argv[outFlag + 1]
      ? path.resolve(argv[outFlag + 1]!)
      : path.join(repoRoot, '.tmp/depgraph/graph.json');

  const payload = buildPayload();
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const valueCycles = payload.cycles.filter((cycle) => cycle.kind === 'value').length;
  const otherCycles = payload.cycles.length - valueCycles;
  const backEdges = payload.edges.filter(([, , , flags]) => flags & 1).length;
  const transitivelyReachable = payload.edges.filter(([, , , flags]) => flags & 2).length;
  const typeInversions = Object.values(payload.typeInversions).reduce((sum, n) => sum + n, 0);
  process.stdout.write(
    `Dependency graph: ${payload.generated.files} files, ${payload.generated.edges} edges, ` +
      `${payload.zones.length} zones\n` +
      `  value-import cycles (R4): ${valueCycles}\n` +
      `  type-only/dynamic cycles (not gate-rejected): ${otherCycles}\n` +
      `  spine back-edges (R5): ${backEdges}\n` +
      `  type-only spine inversions (R6): ${typeInversions}\n` +
      `  value edges whose target is also reachable at distance >= 2: ${transitivelyReachable}\n` +
      `    (reachability only — not a removability claim, see scripts/depgraph/README.md)\n` +
      `  wrote ${path.relative(repoRoot, jsonPath)}\n`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`depgraph: ${error instanceof Error ? error.message : error}\n`);
    return 1;
  });
}
