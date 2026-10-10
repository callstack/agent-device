// Catches: the daemon's internal layering drifting silently — a production file under `src/daemon/`
//   that no layer owns, an owned file that moved or disappeared, a file claimed by two layers, or a
//   static import that reads UP the daemon-local order (core < resources < execution < sessions <
//   server). The global spine ranks all five at daemon-server's rank 4, so R5/R6 cannot see any
//   edge inside the daemon, and R80 cannot see a cycle inside the zone either; this rule is the
//   only direction claim over the daemon's interior. Dynamic imports crossing layers are reported
//   explicitly, never rejected: the route loaders in `request-handler-chain.ts` defer exactly the
//   handlers the eager closure must not carry, and R5 made the same dynamic-vs-static decision
//   (#3280). Omitted, duplicated, and unknown manifest entries fail so the manifest cannot decay
//   into fiction while the edge rule keeps passing.
// Evidence: #3391 landed this partition; measured against the c2c09d476 graph it holds zero
//   upward static value or type edges, which the manifest reproduces and this verifier re-checks.
// Cost: attributed to the R81 rule registration in check.ts; not a standalone CI job.
// Kill criterion: once each layer lives in its own folder under the daemon and the folder derives
//   the layer the way `topFolder` derives zones, the file list retires and the edge rule stays.

import fs from 'node:fs';
import path from 'node:path';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';
import { isProductionSourceFile } from './tracked-sources.ts';

export const DAEMON_LAYER_RULE = 'R81 daemon-layers';

/** The daemon-local order, lowest first. The global spine rank stays 4 for all five layers. */
export const DAEMON_LAYER_ORDER = [
  'daemon-core',
  'daemon-resources',
  'daemon-execution',
  'daemon-sessions',
  'daemon-server',
] as const;

export type DaemonLayer = (typeof DAEMON_LAYER_ORDER)[number];

/** The manifest shape: each declared layer claims the production files it owns. */
export type DaemonLayerManifest = Readonly<Record<string, readonly string[]>>;

const MANIFEST_RELPATH = 'scripts/layering/daemon-layer-manifest.json';

export function isDaemonLayer(layer: string): layer is DaemonLayer {
  return (DAEMON_LAYER_ORDER as readonly string[]).includes(layer);
}

export function daemonLayerRank(layer: DaemonLayer): number {
  return DAEMON_LAYER_ORDER.indexOf(layer);
}

/**
 * The exhaustive `{layer: sourcePaths}` claim over every production file under `src/daemon/`,
 * committed next to this verifier so moving a file into its layer's folder carries its ownership
 * with it.
 */
export function readDaemonLayerManifest(repoRoot: string): DaemonLayerManifest {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, MANIFEST_RELPATH), 'utf8'),
  ) as DaemonLayerManifest;
}

/** `src/daemon/<…>.ts` and not a test or fixture path — the only entries the manifest may name. */
function isDaemonProductionPath(file: string): boolean {
  return file.startsWith('src/daemon/') && isProductionSourceFile(file);
}

/** The partition flattened to one lookup; a path in two layers keeps its first claim. */
export function daemonLayerByFile(
  manifest: DaemonLayerManifest,
): ReadonlyMap<string, DaemonLayer | string> {
  const byFile = new Map<string, DaemonLayer | string>();
  for (const [layer, files] of Object.entries(manifest)) {
    for (const file of files) {
      if (!byFile.has(file)) byFile.set(file, layer);
    }
  }
  return byFile;
}

function manifestFileViolation(message: string): LayeringViolation {
  return { rule: DAEMON_LAYER_RULE, file: MANIFEST_RELPATH, line: 1, message };
}

/**
 * Manifest-vs-tree drift: production daemon files the manifest omits, entries that name a path
 * which is not a tracked production daemon file, a path claimed by two layers, and layer keys
 * outside the declared order.
 */
export function daemonLayerManifestDrift(
  trackedDaemonProductionFiles: readonly string[],
  manifest: DaemonLayerManifest,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];

  for (const layer of Object.keys(manifest)) {
    if (!isDaemonLayer(layer)) {
      violations.push(
        manifestFileViolation(
          `unknown daemon layer "${layer}". Declared layers: ${DAEMON_LAYER_ORDER.join(', ')}.`,
        ),
      );
    }
  }
  for (const layer of DAEMON_LAYER_ORDER) {
    if (manifest[layer] === undefined) {
      violations.push(
        manifestFileViolation(
          `layer "${layer}" is missing from the manifest. Every declared layer must own files or leave the order.`,
        ),
      );
    }
  }

  const tracked = new Set(trackedDaemonProductionFiles);
  const claimed = new Set<string>();
  for (const [layer, files] of Object.entries(manifest)) {
    for (const file of files) {
      if (!isDaemonProductionPath(file)) {
        violations.push(
          manifestFileViolation(
            `entry "${file}" is not a production path under src/daemon/. Test files, fixtures, and paths outside the daemon carry no layer.`,
          ),
        );
        continue;
      }
      if (claimed.has(file)) {
        violations.push(
          manifestFileViolation(
            `"${file}" is claimed by more than one layer, again under "${layer}". A file belongs to exactly one layer.`,
          ),
        );
        continue;
      }
      claimed.add(file);
      if (!tracked.has(file)) {
        violations.push(
          manifestFileViolation(
            `"${file}" is owned by "${layer}" but is not a tracked production file. Move the entry with the file, in the same change.`,
          ),
        );
      }
    }
  }

  for (const file of [...tracked].sort()) {
    if (!claimed.has(file)) {
      violations.push({
        rule: DAEMON_LAYER_RULE,
        file,
        line: 1,
        message:
          `production daemon file is in no layer. Assign it in ${MANIFEST_RELPATH}; ` +
          'defaulting it silently hides its position in the order.',
      });
    }
  }
  return violations;
}

function rankedLayerPair(
  edge: ResolvedImportEdge,
  layerByFile: ReadonlyMap<string, string>,
): Readonly<{ from: DaemonLayer; to: DaemonLayer }> | null {
  const from = layerByFile.get(edge.file);
  const to = layerByFile.get(edge.target);
  if (from === undefined || to === undefined || !isDaemonLayer(from) || !isDaemonLayer(to)) {
    return null;
  }
  return { from, to };
}

/** Static value or type-only edges that read up the daemon-local order. */
export function upwardDaemonLayerEdges(
  edges: readonly ResolvedImportEdge[],
  layerByFile: ReadonlyMap<string, string>,
): ResolvedImportEdge[] {
  return edges.filter((edge) => {
    if (edge.dynamic) return false;
    const pair = rankedLayerPair(edge, layerByFile);
    return pair !== null && daemonLayerRank(pair.from) < daemonLayerRank(pair.to);
  });
}

/**
 * Dynamic imports whose target sits in a different daemon layer. Reported on the check's stdout,
 * never failed — the report keeps the lazy seams visible while the layer folders land.
 */
export function dynamicCrossLayerDaemonEdges(
  edges: readonly ResolvedImportEdge[],
  layerByFile: ReadonlyMap<string, string>,
): ResolvedImportEdge[] {
  return edges.filter((edge) => {
    if (!edge.dynamic) return false;
    const pair = rankedLayerPair(edge, layerByFile);
    return pair !== null && pair.from !== pair.to;
  });
}

/**
 * The registered R81 check. `trackedDaemonProductionFiles` is the daemon half of the context's
 * production scan, so tests and fixtures carry no layer, matching how the other daemon rules
 * treat them.
 */
export function checkDaemonLayers(
  trackedDaemonProductionFiles: readonly string[],
  edges: readonly ResolvedImportEdge[],
  manifest: DaemonLayerManifest,
  report: (line: string) => void = (line) => process.stdout.write(line),
): LayeringViolation[] {
  const violations = daemonLayerManifestDrift(trackedDaemonProductionFiles, manifest);
  const layerByFile = daemonLayerByFile(manifest);
  for (const edge of upwardDaemonLayerEdges(edges, layerByFile)) {
    const pair = rankedLayerPair(edge, layerByFile)!;
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
  const dynamic = dynamicCrossLayerDaemonEdges(edges, layerByFile);
  if (dynamic.length > 0) {
    report(
      `Layering guard: R81 reports ${dynamic.length} dynamic cross-layer daemon edge(s) ` +
        `(reported, not rejected; see scripts/layering/daemon-layers.ts):\n`,
    );
    for (const edge of dynamic) {
      const pair = rankedLayerPair(edge, layerByFile)!;
      const upward =
        daemonLayerRank(pair.from) < daemonLayerRank(pair.to) ? ' [upward, reported only]' : '';
      report(`  ${edge.file} (${pair.from}) -> ${edge.target} (${pair.to})${upward}\n`);
    }
  }
  return violations;
}
