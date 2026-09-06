import { isProductionSourceFile } from './tracked-sources.ts';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

// The classified inventory of every production daemon import of a root platform-runtime
// composition module (#2278, ADR 0022). R65 already bans daemon imports of concrete platform
// packages and the retired src/platforms zone; the root src/platform-runtime*.ts family is the
// one composition layer the daemon may still touch, and this table is the classification of
// every edge that does. An edge is unclassifiable until it is recorded here with a rationale,
// and a recorded edge that no longer exists is stale — both fail, so the inventory and the
// tree cannot drift apart in either direction.

export const DAEMON_PLATFORM_RUNTIME_RULE = 'R74 daemon-platform-runtime-inventory';

export type DaemonPlatformRuntimeClassification =
  | 'composition-essential'
  | 'daemon-policy-essential'
  | 'leaked-platform-mechanics';

export type DaemonPlatformRuntimeEdge = Readonly<{
  file: string;
  target: string;
  /** Exact named symbols across every edge of the pair; empty for dynamic/side-effect imports. */
  symbols: readonly string[];
  classification: DaemonPlatformRuntimeClassification;
  rationale: string;
  /** The seam or child issue that deepens a leaked-platform-mechanics edge. */
  deepenedBy?: string;
}>;

/** The root platform-runtime composition family: src/platform-runtime.ts and src/platform-runtime-*.ts. */
export function isRootPlatformRuntimeTarget(target: string): boolean {
  return /^src\/platform-runtime(?:\.ts|-[a-z0-9-]+\.ts)$/.test(target);
}

/**
 * Measured on origin/main 6e22e266d7 for #2278: 14 production edges in 9 daemon files.
 * The ios-app-session-hint entry covers two edges (the import and the re-export of the
 * same symbol); every other entry is one edge.
 */
export const DAEMON_PLATFORM_RUNTIME_EDGES: readonly DaemonPlatformRuntimeEdge[] = [
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/platform-runtime.ts',
    symbols: [
      'androidObservation',
      'createPlatformRuntimeGateway',
      'createPlatformDeviceInventoryGateways',
      'createRequestPlatformProviders',
    ],
    classification: 'composition-essential',
    rationale:
      'process-root assembly of the neutral runtime gateway, device-inventory gateways, and ' +
      'request platform providers (ADR 0019 section 1/2 boundary); the daemon holds no ' +
      'platform mechanics at this site, only the composition the process root owns.',
  },
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/platform-runtime-host-diagnostics.ts',
    symbols: ['createHostDiagnostics'],
    classification: 'composition-essential',
    rationale:
      'process-root assembly of the neutral HostDiagnostics contract capability; the ' +
      'per-family probes load lazily inside the root module, so the daemon consumes only ' +
      'the contract surface.',
  },
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/platform-runtime-apple-runner-owner.ts',
    symbols: [
      'configureAppleRunnerDeviceClaimAuthorityProbe',
      'configureAppleRunnerLeaseOwnerStateDir',
    ],
    classification: 'leaked-platform-mechanics',
    rationale:
      'daemon startup/shutdown names the Apple runner owner directly; the daemon-owned ' +
      'inputs (lease-owner state dir, claim-authority probe) should flow through typed ' +
      'lifecycle participation instead of configure calls into a platform-composed owner.',
    deepenedBy: '#2333',
  },
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/platform-runtime-resource-cleanup.ts',
    symbols: [
      'cleanupManagedWebRuntimeOrphans',
      'platformResourceCleanup',
      'resetAndroidSnapshotHelperRuntime',
    ],
    classification: 'leaked-platform-mechanics',
    rationale:
      'startup/shutdown cleanup participation names the Android snapshot-helper and Web ' +
      'orphan owners directly; platformResourceCleanup (the neutral PlatformResourceCleanup ' +
      'contract) is the model the other two symbols should follow.',
    deepenedBy: '#2333',
  },
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/platform-runtime-operation-host.ts',
    symbols: [],
    classification: 'leaked-platform-mechanics',
    rationale:
      'daemon startup names app-log legacy marker recovery, a platform process mechanic; ' +
      'it should join the same typed lifecycle participation as the other startup cleanups.',
    deepenedBy: '#2333',
  },
  {
    file: 'src/daemon/device-claim-owner-recovery.ts',
    target: 'src/platform-runtime.ts',
    symbols: ['createPlatformRuntimeGateway'],
    classification: 'composition-essential',
    rationale:
      "per-transaction neutral gateway assembly scoped to the dead owner's state dir " +
      '(#2168); the process root cannot carry a per-claim sessionsDir, so the scoped ' +
      "composition belongs to the recovery policy's own module.",
  },
  {
    file: 'src/daemon/device-ready.ts',
    target: 'src/platform-runtime-device-ready.ts',
    symbols: ['ensureLocalPlatformDeviceReady'],
    classification: 'composition-essential',
    rationale:
      'neutral local-device-readiness port assembled at the root composition layer (the ' +
      'platform dispatch is internal to the root module); the daemon keeps its TTL cache ' +
      'and provider-device policy locally.',
  },
  {
    file: 'src/daemon/direct-ios-selector.ts',
    target: 'src/platform-runtime-apple-resources.ts',
    symbols: ['queryAppleRuntimeSelector'],
    classification: 'leaked-platform-mechanics',
    rationale:
      'the direct-iOS fast path queries the Apple runner selector mechanics directly; the ' +
      'selector-producer seam owned by #2273/#2274 is the accepted deepening, and this ' +
      'audit deliberately adds no second selector producer.',
    deepenedBy: '#2273, #2274',
  },
  {
    file: 'src/daemon/ios-app-session-hint.ts',
    target: 'src/platform-runtime-open-target.ts',
    symbols: ['resolveSoleForegroundIosApp'],
    classification: 'leaked-platform-mechanics',
    rationale:
      'the open-hint policy (daemon-owned: when to emit, length bound, never-guess) calls ' +
      'the Apple foreground-app probe and re-exports it; the probe should arrive through ' +
      'a semantic observation port instead of the mixed open-target module.',
    deepenedBy: '#2332',
  },
  {
    file: 'src/daemon/request-recording-health.ts',
    target: 'src/platform-runtime-apple-resources.ts',
    symbols: ['inspectAppleRunnerSession'],
    classification: 'leaked-platform-mechanics',
    rationale:
      'recording-health refresh reads the Apple runner session mechanics directly; the ' +
      'daemon needs a semantic runner-session observation (alive plus current session id), ' +
      'not the runner probe.',
    deepenedBy: '#2332',
  },
  {
    file: 'src/daemon/session-device-resolution.ts',
    target: 'src/platform-runtime-apple-resources.ts',
    symbols: ['inspectAppleRunnerSession'],
    classification: 'leaked-platform-mechanics',
    rationale:
      'device refresh uses a live runner session as simulator-boot evidence; the daemon ' +
      'needs the same semantic runner-session observation as recording health, not the ' +
      'runner probe.',
    deepenedBy: '#2332',
  },
  {
    file: 'src/daemon/handlers/session-selector-dispatch.ts',
    target: 'src/platform-runtime-open-target.ts',
    symbols: ['resolveAndroidPackageForOpen', 'resolveSessionAppBundleIdForTarget'],
    classification: 'leaked-platform-mechanics',
    rationale:
      'selector dispatch consumes the mixed open-target module; Android package resolution ' +
      'is platform mechanics that should sit behind the Android owning seam.',
    deepenedBy: '#2334',
  },
  {
    file: 'src/daemon/session-lifecycle/internal/session-open-prepare.ts',
    target: 'src/platform-runtime-open-target.ts',
    symbols: ['resolveRequestedOpenSurface', 'validateOpenRelaunchTarget'],
    classification: 'leaked-platform-mechanics',
    rationale:
      'open-prepare policy consumes the mixed open-target module; the neutral open ' +
      'plan/result should be separated from the platform mechanics that share the file.',
    deepenedBy: '#2334',
  },
] as const;

function keyOf(file: string, target: string): string {
  return `${file} -> ${target}`;
}

function sorted(symbols: readonly string[]): string[] {
  return [...symbols].sort();
}

/**
 * Catches: unclassified daemon-to-root platform-runtime coupling regrowing — a new edge (or a
 *   new symbol on an existing edge) that the #2278 audit never classified, and the mirror
 *   failure, a classified edge that no longer exists and would silently admit its return.
 * Evidence: #2278 measured 14 production edges in 9 daemon files at origin/main 6e22e266d7;
 *   this table is that measurement, classified per ADR 0022.
 * Cost: attributed to the R74 rule registration in check.ts; not a standalone CI job.
 * Kill criterion: the daemon reaches the platform only through the gateway and declared
 *   contract capabilities (the inventory empty), or a maintainer decision retires the
 *   classification requirement.
 */
export function checkDaemonPlatformRuntimeInventory(
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  const actual = new Map<string, { line: number; symbols: Set<string> }>();
  for (const edge of edges) {
    if (!edge.file.startsWith('src/daemon/')) continue;
    if (!isProductionSourceFile(edge.file)) continue;
    if (!isRootPlatformRuntimeTarget(edge.target)) continue;
    const key = keyOf(edge.file, edge.target);
    const entry = actual.get(key) ?? { line: edge.line, symbols: new Set<string>() };
    for (const symbol of edge.symbols) entry.symbols.add(symbol);
    actual.set(key, entry);
  }

  const violations: LayeringViolation[] = [];
  const seen = new Set<string>();

  for (const [key, entry] of actual) {
    const declaration = DAEMON_PLATFORM_RUNTIME_EDGES.find(
      (candidate) => keyOf(candidate.file, candidate.target) === key,
    );
    if (declaration === undefined) {
      violations.push({
        rule: DAEMON_PLATFORM_RUNTIME_RULE,
        file: key.split(' -> ')[0]!,
        line: entry.line,
        message:
          `unclassified daemon-to-root platform-runtime coupling: ${key}. Classify it in ` +
          `DAEMON_PLATFORM_RUNTIME_EDGES (${DAEMON_PLATFORM_RUNTIME_RULE}) with its rationale, ` +
          `or remove the coupling.`,
      });
      continue;
    }
    seen.add(key);
    const expected = sorted(declaration.symbols);
    const measured = sorted([...entry.symbols]);
    if (expected.join('\u0000') !== measured.join('\u0000')) {
      violations.push({
        rule: DAEMON_PLATFORM_RUNTIME_RULE,
        file: key.split(' -> ')[0]!,
        line: entry.line,
        message:
          `classified symbols drifted for ${key}: the tree imports ${measured.join(', ') || '(none)'} ` +
          `but the inventory records ${expected.join(', ') || '(none)'}. Update the inventory ` +
          `entry in the same change, or remove the added coupling.`,
      });
    }
  }

  for (const declaration of DAEMON_PLATFORM_RUNTIME_EDGES) {
    const key = keyOf(declaration.file, declaration.target);
    if (actual.has(key) || seen.has(key)) continue;
    violations.push({
      rule: DAEMON_PLATFORM_RUNTIME_RULE,
      file: 'scripts/layering/daemon-platform-runtime-inventory.ts',
      line: 1,
      message:
        `stale classified edge: ${key} no longer exists. Remove the entry so the coupling ` +
        `cannot return unclassified.`,
    });
  }

  return violations;
}
