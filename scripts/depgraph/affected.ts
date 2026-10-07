// Blast-radius model — "who depends on this file, and which gates and live scenarios own them".
//
// Pure functions only: every input (graph edges, command routes, guarantee matrix rows, live
// coverage manifest) is passed in by `affected-run.ts`, so the traversal and the bounded
// presentation are testable without touching the tree, git, or the daemon.
//
// The graph itself comes from `scripts/depgraph/model.ts`, which is extracted with the layering
// gate's own model — the dependents reported here are exactly the edges CI enforces.

import { genBFS, getPredecessors, type Graph, type TraversalDirection } from '@statelyai/graph';
import { EXECUTABLE_EDGES, importGraph, VALUE_EDGES } from './import-graph.ts';
import type { GraphEdge, GraphNode } from './model.ts';

/** Every node a breadth-first walk reaches from `start`, excluding `start` itself. */
function reachable(
  graph: Graph,
  start: string,
  direction: TraversalDirection = 'outgoing',
): Set<string> {
  const seen = new Set<string>();
  for (const node of genBFS(graph, { from: start, direction })) seen.add(node.id);
  seen.delete(start);
  return seen;
}

export type DependentSet = {
  /** Files that import the target directly (value edges). */
  direct: string[];
  /** Every file that reaches the target over value edges, direct ones included. */
  all: string[];
  /** `all` minus `direct`, i.e. reachable only through at least one hop. */
  transitiveOnly: string[];
};

/**
 * Reverse reachability over value edges: everything that would recompile, retype, or re-run
 * because of an edit to `file`. Type-only and dynamic dependents are deliberately excluded —
 * they are a different question (a type-only edge is free at runtime) and mixing them would
 * make the count unactionable.
 */
export function collectDependents(file: string, edges: readonly GraphEdge[]): DependentSet {
  const valueGraph = importGraph(edges, VALUE_EDGES, [file]);
  const direct = getPredecessors(valueGraph, file)
    .map((node) => node.id)
    .sort();
  const all = [...reachable(valueGraph, file, 'incoming')].sort();
  const directSet = new Set(direct);
  return { direct, all, transitiveOnly: all.filter((entry) => !directSet.has(entry)) };
}

/**
 * Direct importers over the edge kinds `collectDependents` leaves out. A pure vocabulary module
 * has zero value dependents and dozens of type-only ones; reporting only the value count there
 * would read as "nothing depends on this", which is the opposite of true.
 */
export function weakDirectDependents(
  file: string,
  edges: readonly GraphEdge[],
): { type: number; dynamic: number } {
  let type = 0;
  let dynamic = 0;
  for (const edge of edges) {
    if (edge.to !== file) continue;
    if (edge.kind === 'type') type++;
    if (edge.kind === 'dynamic') dynamic++;
  }
  return { type, dynamic };
}

export type ZoneCount = { zone: string; count: number };

/** Dependent count per zone, biggest first — "which boundaries does this edit cross". */
export function zoneBreakdown(
  files: readonly string[],
  nodes: ReadonlyMap<string, GraphNode>,
): ZoneCount[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const zone = nodes.get(file)?.zone ?? '(unknown)';
    counts.set(zone, (counts.get(zone) ?? 0) + 1);
  }
  return [...counts]
    .map(([zone, count]) => ({ zone, count }))
    .sort((left, right) => right.count - left.count || left.zone.localeCompare(right.zone));
}

/** Dependents ordered by their own fan-in: the ones whose breakage spreads furthest. */
export function rankByFanIn(
  files: readonly string[],
  nodes: ReadonlyMap<string, GraphNode>,
): { file: string; fanIn: number }[] {
  return files
    .map((file) => ({ file, fanIn: nodes.get(file)?.fanIn ?? 0 }))
    .sort((left, right) => right.fanIn - left.fanIn || left.file.localeCompare(right.file));
}

export type CommandChain = {
  command: string;
  /** Daemon route that owns the command (`src/daemon/daemon-command-registry.ts`). */
  route: string;
  /** Handler entry module the route loads. */
  entry: string;
};

/**
 * Public commands whose handler chain reaches `file`. The chain is the executable closure of
 * the route's handler entry module, so a command claims the file when its handler can actually
 * run the code — not merely when the names look related.
 */
export function commandsReaching(
  file: string,
  chains: readonly CommandChain[],
  edges: readonly GraphEdge[],
): CommandChain[] {
  const executableGraph = importGraph(
    edges,
    EXECUTABLE_EDGES,
    chains.map((chain) => chain.entry),
  );
  const closures = new Map<string, Set<string>>();
  const closureFor = (entry: string): Set<string> => {
    let closure = closures.get(entry);
    if (!closure) {
      closure = reachable(executableGraph, entry);
      closure.add(entry);
      closures.set(entry, closure);
    }
    return closure;
  };
  return chains
    .filter((chain) => closureFor(chain.entry).has(file))
    .sort((left, right) => left.command.localeCompare(right.command));
}

export type GuaranteeRow = {
  path: string;
  guarantee: string;
  kind: string;
  via: string;
};

/**
 * ADR 0011 matrix rows implemented by `file`. A cell's `via` is
 * `<module path>#<symbol>` for runtime/runner cells and prose for delegated ones, so only the
 * module-qualified form can be matched — prose cells belong to no file by construction.
 */
export function guaranteeRowsForFile(file: string, rows: readonly GuaranteeRow[]): GuaranteeRow[] {
  return rows.filter((row) => row.via.split('#')[0] === file);
}

/** A bounded slice plus the number of entries it hid, so counts never lie to the reader. */
export type Bounded<T> = { shown: T[]; hidden: number };

export function bound<T>(items: readonly T[], limit: number): Bounded<T> {
  return { shown: items.slice(0, limit), hidden: Math.max(0, items.length - limit) };
}

/** `a, b, c (+4 more)` — the one place the "+N more" convention is spelled. */
export function formatBounded<T>(bounded: Bounded<T>, render: (item: T) => string): string {
  const rendered = bounded.shown.map(render).join(', ');
  if (bounded.hidden === 0) return rendered || '(none)';
  return `${rendered} (+${bounded.hidden} more)`;
}
