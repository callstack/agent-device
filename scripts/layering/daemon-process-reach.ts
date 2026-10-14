import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

export const DAEMON_PROCESS_REACH_RULE = 'R82 daemon-process-reach';

/** The module a daemon process starts from. */
export const DAEMON_PROCESS_ENTRY = 'src/daemon.ts';

/**
 * Modules the daemon process must never load. The client reads the caller's replay scripts and
 * ships their contents in the request; the daemon only ever sees that bundle, never caller paths.
 */
export const DAEMON_PROCESS_DENIED_MODULES: readonly string[] = [
  'packages/replay-port/src/script-source-bundle.ts',
  'packages/replay-port/src/source-discovery.ts',
];

/**
 * Catches: any module the daemon process can load — over static and dynamic edges, so the
 *   composition root and every platform-runtime module behind a function-scoped `await import`
 *   count — reaching a denied module. The violation names the edge that brings the denied module
 *   in and the shortest chain from the entry to it. An entry or denied module that is not a
 *   tracked source fails as stale, so a rename or move cannot turn the walk into a silent pass.
 * Evidence: the client-only placement of replay-port's caller-side collector was a convention
 *   until #3517; a path-scoped R11 gate covered only files under the daemon root plus two named
 *   root files, so a root platform-runtime module or a reached package could still import it.
 * Cost: one breadth-first walk over the already-resolved edges, inside `pnpm check:layering`.
 * Kill criterion: the collector moves into a package the daemon package cannot depend on.
 */
export function checkDaemonProcessReach(
  sourceFiles: readonly string[],
  edges: readonly ResolvedImportEdge[],
  entry: string = DAEMON_PROCESS_ENTRY,
  denied: readonly string[] = DAEMON_PROCESS_DENIED_MODULES,
): LayeringViolation[] {
  const tracked = new Set(sourceFiles);
  const stale = [entry, ...denied].filter((module) => !tracked.has(module));
  if (stale.length > 0) {
    return stale.map((module) => ({
      rule: DAEMON_PROCESS_REACH_RULE,
      file: 'scripts/layering/daemon-process-reach.ts',
      line: 1,
      message:
        `stale module: ${module} is not a tracked source. Point DAEMON_PROCESS_ENTRY or ` +
        `DAEMON_PROCESS_DENIED_MODULES at its new path so the reach check keeps a real target.`,
    }));
  }
  const outgoing = new Map<string, ResolvedImportEdge[]>();
  for (const edge of edges) {
    if (edge.typeOnly && !edge.dynamic) continue;
    const list = outgoing.get(edge.file) ?? [];
    list.push(edge);
    outgoing.set(edge.file, list);
  }
  const cameFrom = new Map<string, ResolvedImportEdge | null>([[entry, null]]);
  const queue = [entry];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    for (const edge of outgoing.get(current) ?? []) {
      if (cameFrom.has(edge.target)) continue;
      cameFrom.set(edge.target, edge);
      queue.push(edge.target);
    }
  }
  const violations: LayeringViolation[] = [];
  for (const module of denied) {
    const via = cameFrom.get(module);
    if (!via) continue;
    const chain: string[] = [module];
    for (let at = via; at; at = cameFrom.get(at.file) ?? null) chain.unshift(at.file);
    violations.push({
      rule: DAEMON_PROCESS_REACH_RULE,
      file: via.file,
      line: via.line,
      message:
        `${entry} reaches ${module}, which the daemon process must never load: the daemon ` +
        `receives the client's replay source bundle and does not read caller paths. ` +
        `Chain: ${chain.join(' -> ')}.`,
    });
  }
  return violations;
}
