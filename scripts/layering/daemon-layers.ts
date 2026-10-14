// Catches: the daemon's internal layering drifting silently — a production file under the daemon
//   root that no layer folder owns, or a static import that reads UP the daemon-local order
//   (core < resources < execution < sessions < server). The folder is the declaration: the layer
//   is the first path segment under the daemon root, the way `topFolder` derives zones in
//   root-module-zones. The manifest that PR #3391 carried until the folders landed is retired;
//   its drift check retired with it, because a file's ownership now moves with the file itself.
//   The global spine ranks all five layers at daemon-server's rank 4, so R5/R6 cannot see any
//   edge inside the daemon, and R80 cannot see a cycle inside the zone either; this rule is the
//   only direction claim over the daemon's interior. Dynamic imports crossing layers are reported
//   explicitly, never rejected: the route loaders in `request-handler-chain.ts` defer exactly the
//   handlers the eager closure must not carry, and R5 made the same dynamic-vs-static decision
//   (#3280). An unknown first segment (or a production file sitting at the daemon root) fails,
//   so a new file cannot enter the zone without picking a layer.
// Evidence: #3391 landed the partition; PR 10 moved each layer into its folder and re-measured
//   the zero upward static value-or-type edge claim against the moved graph.
// Cost: attributed to the R81 rule registration in check.ts; not a standalone CI job.

import path from 'node:path';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';
import { DAEMON_SOURCE_ROOT, isProductionSourceFile } from './tracked-sources.ts';

export const DAEMON_LAYER_RULE = 'R81 daemon-layers';

/** The daemon zone root without its trailing slash, from the one scan constant (#3546). */
export const DAEMON_ROOT = DAEMON_SOURCE_ROOT.slice(0, -1);

/** The daemon-local order, lowest first. The global spine rank stays 4 for all five layers. */
export const DAEMON_LAYER_ORDER = ['core', 'resources', 'execution', 'sessions', 'server'] as const;

export type DaemonLayer = (typeof DAEMON_LAYER_ORDER)[number];

function isDaemonLayer(segment: string): segment is DaemonLayer {
  return (DAEMON_LAYER_ORDER as readonly string[]).includes(segment);
}

function daemonLayerRank(layer: DaemonLayer): number {
  return DAEMON_LAYER_ORDER.indexOf(layer);
}

/** Files under the daemon root that are not tests or fixtures. */
function isDaemonProductionPath(file: string): boolean {
  return file.startsWith(DAEMON_SOURCE_ROOT) && isProductionSourceFile(file);
}

/**
 * The folder-derived layer: the first path segment under the daemon root, for production files
 * only. Tests and test support mirror their source module by convention and carry no layer,
 * matching how the other daemon rules treat them; the top-level `__tests__/support/` tree rides
 * with them. Returns null for anything the folders do not own.
 */
export function daemonLayerOf(file: string): DaemonLayer | null {
  if (!isDaemonProductionPath(file)) return null;
  const segment = path.relative(DAEMON_ROOT, file).split(path.sep)[0];
  return isDaemonLayer(segment) ? segment : null;
}

/**
 * The single handler-folder rule: any file under `<layer>/handlers/` at any depth, whichever
 * layer the folder sits under. The old flat `handlers/` tree split into sessions/handlers/ and
 * execution/handlers/, and R75's authority ratchet and the façade policies guard the handler
 * surface, not one recorded pair of paths — deriving membership from the folder shape here means
 * a handler folder planted under a different layer joins every handler rule with no edit.
 */
export function isDaemonHandlerFile(file: string): boolean {
  if (!file.startsWith(DAEMON_SOURCE_ROOT)) return false;
  const [layer, second] = file.slice(DAEMON_SOURCE_ROOT.length).split('/');
  return isDaemonLayer(layer) && second === 'handlers';
}

/**
 * The registered R81 check. `trackedDaemonProductionFiles` is the daemon half of the context's
 * production scan. Every one of them must sit under a declared layer folder, and no static edge
 * may read up the order.
 */
export function checkDaemonLayers(
  trackedDaemonProductionFiles: readonly string[],
  edges: readonly ResolvedImportEdge[],
  report: (line: string) => void = (line) => process.stdout.write(line),
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];

  // An empty input set means the caller's scan no longer reaches this tree — the same wiring
  // drift a stale DAEMON_SOURCE_ROOT literal at a call site produces. A rule that measures
  // nothing proves nothing, so it fails instead of passing silently.
  if (trackedDaemonProductionFiles.length === 0) {
    return [
      {
        rule: DAEMON_LAYER_RULE,
        file: DAEMON_SOURCE_ROOT,
        line: 1,
        message:
          `R81 received no tracked production files under ${DAEMON_SOURCE_ROOT}. The scan filter ` +
          `and the daemon root have diverged, or the daemon root moved; the layer claim would ` +
          `pass without measuring anything.`,
      },
    ];
  }

  for (const file of trackedDaemonProductionFiles) {
    // The context's scan names every tracked TS file in the zone; tests and test support mirror
    // their source module by convention and carry no folder claim.
    if (!isProductionSourceFile(file)) continue;
    if (daemonLayerOf(file) === null) {
      const rest = path.relative(DAEMON_ROOT, file);
      violations.push({
        rule: DAEMON_LAYER_RULE,
        file,
        line: 1,
        message:
          `production daemon file is not under a layer folder. The layer is the first segment ` +
          `under ${DAEMON_SOURCE_ROOT} (${DAEMON_LAYER_ORDER.join(' < ')}); "${rest}" does not ` +
          `start with one. A new file must pick its layer, not linger at the zone root or hide ` +
          `behind an invented folder.`,
      });
    }
  }

  const rankedPair = (edge: ResolvedImportEdge) => {
    const from = daemonLayerOf(edge.file);
    const to = daemonLayerOf(edge.target);
    return from !== null && to !== null ? { from, to } : null;
  };

  for (const edge of edges) {
    if (edge.dynamic) continue;
    const pair = rankedPair(edge);
    if (pair === null || daemonLayerRank(pair.from) >= daemonLayerRank(pair.to)) continue;
    violations.push({
      rule: DAEMON_LAYER_RULE,
      file: edge.file,
      line: edge.line,
      message:
        `${edge.typeOnly ? 'type-only' : 'value'} import reads up the daemon layer order: ` +
        `${edge.file} (${pair.from}) ${edge.typeOnly ? 'types' : 'imports'} ${edge.target} ` +
        `(${pair.to}). Move the shared contract below both layers, or call down to the ` +
        `lower layer's owner instead of reading upward.`,
    });
  }

  const dynamic = edges.filter((edge) => {
    if (!edge.dynamic) return false;
    const pair = rankedPair(edge);
    return pair !== null && pair.from !== pair.to;
  });
  if (dynamic.length > 0) {
    report(
      `Layering guard: R81 reports ${dynamic.length} dynamic cross-layer daemon edge(s) ` +
        `(reported, not rejected; see scripts/layering/daemon-layers.ts):\n`,
    );
    for (const edge of dynamic) {
      const pair = rankedPair(edge)!;
      const upward =
        daemonLayerRank(pair.from) < daemonLayerRank(pair.to) ? ' [upward, reported only]' : '';
      report(`  ${edge.file} (${pair.from}) -> ${edge.target} (${pair.to})${upward}\n`);
    }
  }
  return violations;
}
