import { genDFS } from '@statelyai/graph';
import { isProductionSourceFile } from './tracked-sources.ts';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';
import { ALL_EDGES, importGraphFromResolvedEdges } from '../depgraph/import-graph.ts';

export const DAEMON_PLATFORM_RUNTIME_RULE = 'R76 daemon-platform-runtime-inventory';

/** The root platform-runtime composition family: src/platform-runtime.ts and src/platform-runtime-*.ts. */
export function isRootPlatformRuntimeTarget(target: string): boolean {
  return /^src\/platform-runtime(?:\.ts|-[a-z0-9-]+\.ts)$/.test(target);
}

/**
 * Every module outside the daemon zone through which a daemon import can reach the root
 * platform-runtime family: the family itself, plus anything that imports it, transitively, over
 * static and dynamic edges alike. Computed from the tree rather than patterned so a root hub that
 * carries platform mechanics without naming them gains no immunity from its filename, and so a
 * dynamic edge out of the daemon zone is caught like a static one instead of escaping the rule
 * (#2542).
 */
export function computePlatformMechanicsHubs(
  edges: readonly ResolvedImportEdge[],
): ReadonlySet<string> {
  const roots: string[] = [];
  const rootSet = new Set<string>();
  for (const edge of edges) {
    if (isRootPlatformRuntimeTarget(edge.target) && !rootSet.has(edge.target)) {
      rootSet.add(edge.target);
      roots.push(edge.target);
    }
  }

  const hubs = new Set<string>();
  const graph = importGraphFromResolvedEdges(edges, ALL_EDGES, roots);
  for (const { id: importer } of genDFS(graph, { from: roots, direction: 'incoming' })) {
    if (!importer.startsWith('src/daemon/')) hubs.add(importer);
  }
  return hubs;
}

/**
 * Catches: any production daemon import of the root platform-runtime family, directly or through a
 *   root hub that reaches it, in any static or dynamic form. The #2278 audit classified every edge
 *   that was allowed to exist; the inventory is now empty, so the allowance is retired and every
 *   such edge is a violation naming the pair and its line. Reaching the platform through a root
 *   hub counts the same as reaching it directly, and no dynamic-import form is exempt.
 * Evidence: #2278's 14 classified edges were all retired — the composition edges by #3431, moved
 *   to the process-root composition module outside the daemon zone, and the leaked selector-query
 *   edge by #3430, routed through the request-bound runtime binding. The rule then collapsed to
 *   this ban per its own kill criterion, deleting the classification table and its drift and
 *   staleness passes.
 * Cost: attributed to the R76 rule registration in check.ts; not a standalone CI job.
 * Kill criterion: the daemon moves into its own workspace package, whose package boundary then
 *   forbids these imports structurally.
 */
export function checkDaemonPlatformRuntimeInventory(
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  const hubs = computePlatformMechanicsHubs(edges);
  const violations: LayeringViolation[] = [];
  const reported = new Set<string>();
  for (const edge of edges) {
    if (!edge.file.startsWith('src/daemon/')) continue;
    if (!isProductionSourceFile(edge.file)) continue;
    if (!hubs.has(edge.target)) continue;
    const key = `${edge.file} -> ${edge.target}`;
    if (reported.has(key)) continue;
    reported.add(key);
    violations.push({
      rule: DAEMON_PLATFORM_RUNTIME_RULE,
      file: edge.file,
      line: edge.line,
      message:
        `daemon coupling to root platform mechanics is banned: ${key}. The #2278 ` +
        `classification inventory is retired and empty (${DAEMON_PLATFORM_RUNTIME_RULE}): ` +
        `reach the platform through the gateway or a declared contract capability, or move the ` +
        `responsibility to the process root.`,
    });
  }
  return violations;
}
