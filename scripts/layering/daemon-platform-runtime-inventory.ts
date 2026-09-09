import { isProductionSourceFile } from './tracked-sources.ts';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

// The classified inventory of every production daemon import of a root platform-runtime
// composition module (#2278, ADR 0022). R65 already bans daemon imports of concrete platform
// packages and the retired src/platforms zone; the root src/platform-runtime*.ts family is the
// one composition layer the daemon may still touch, and this table is the classification of
// every edge that does. An edge is unclassifiable until it is recorded here with a rationale,
// and a recorded edge that no longer exists is stale — both fail, so the inventory and the
// tree cannot drift apart in either direction.

export const DAEMON_PLATFORM_RUNTIME_RULE = 'R76 daemon-platform-runtime-inventory';

export type DaemonPlatformRuntimeClassification =
  | 'composition-essential'
  | 'daemon-policy-essential'
  | 'leaked-platform-mechanics';

export type DaemonPlatformRuntimeEdge = Readonly<{
  file: string;
  target: string;
  /**
   * Exact named symbols across every edge of the pair; empty for static side-effect imports (a
   * destructured dynamic import records its bindings, so widening the destructure is a drift, not
   * a silent expansion). Unnameable dynamic-import forms cannot be recorded here, and R76 rejects
   * the edge: a rest or computed destructure binding, or a namespace/side-effect import() call —
   * both expose exports beyond this list.
   */
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
 * The current classified edges from the #2278 audit, ratcheted as owning interfaces land.
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
    target: 'src/platform-runtime-resource-cleanup.ts',
    symbols: ['platformResourceCleanup'],
    classification: 'composition-essential',
    rationale:
      'process-root assembly of the neutral PlatformResourceCleanup contract capability; the ' +
      'Android snapshot-helper reset and Web orphan cleanup that used to be named directly on ' +
      'this edge now sit behind the typed lifecycle-participation surface (#2333, see the ' +
      'platform-runtime-daemon-lifecycle.ts edge below).',
  },
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/platform-runtime-daemon-lifecycle.ts',
    symbols: ['platformDaemonLifecycleOwners'],
    classification: 'composition-essential',
    rationale:
      'process-root assembly of the typed PlatformOwnerLifecycle contract capability (#2333): ' +
      'the daemon keeps ordering, cancellation, and best-effort failure policy for its ' +
      'startup/shutdown platform-owner participation, while this composition module is the ' +
      'sole place that names the Apple runner owner, the Android snapshot-helper and Web ' +
      'orphan cleanups, and legacy app-log marker recovery.',
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
    target: 'src/platform-runtime-apple-resources.ts',
    symbols: ['appleSessionObservation'],
    classification: 'daemon-policy-essential',
    rationale:
      'daemon-owned hint composition and length limits consume the neutral foreground-app ' +
      'observation; the Apple package owns ambiguity and probe mechanics.',
  },
  {
    file: 'src/daemon/request-recording-health.ts',
    target: 'src/platform-runtime-apple-resources.ts',
    symbols: ['appleSessionObservation'],
    classification: 'daemon-policy-essential',
    rationale:
      'daemon-owned recording invalidation consumes only liveness and session identity ' +
      'through the neutral observation contract; runner mechanics stay Apple-owned.',
  },
  {
    file: 'src/daemon/session-device-resolution.ts',
    target: 'src/platform-runtime-apple-resources.ts',
    symbols: ['appleSessionObservation'],
    classification: 'daemon-policy-essential',
    rationale:
      'daemon-owned device refresh uses the neutral runner-session observation as boot ' +
      'evidence; inventory selection and provider exclusions remain local policy.',
  },
  {
    file: 'src/daemon/handlers/session-selector-dispatch.ts',
    target: 'src/platform-runtime-open-target.ts',
    symbols: ['resolveSessionAppBundleIdForTarget'],
    classification: 'daemon-policy-essential',
    rationale:
      'selector dispatch reconstructs the session app-bundle identity after a trigger-app-event ' +
      'deep link through the one neutral open-plan resolver (#2334); Android package resolution ' +
      'moved behind the Android owning seam in packages/platform-android, so the resolver is the ' +
      'only symbol this edge names.',
  },
  {
    file: 'src/daemon/session-lifecycle/internal/session-open-prepare.ts',
    target: 'src/platform-runtime-open-target.ts',
    symbols: ['resolveRequestedOpenSurface', 'validateOpenRelaunchTarget'],
    classification: 'daemon-policy-essential',
    rationale:
      'open-prepare policy consumes only the neutral open plan/result surface (#2334): surface ' +
      'classification and relaunch-target validation. The platform mechanics that used to share ' +
      'the file (Android package resolution) moved behind the Android owning seam, leaving this ' +
      'edge daemon policy over two neutral, non-mechanics functions.',
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
 *   new symbol on an existing edge) that the #2278 audit never classified, the mirror failure, a
 *   classified edge that no longer exists and would silently admit its return, and dynamic
 *   imports whose binding set the inventory cannot name: a rest or computed destructure binding,
 *   or a namespace/side-effect import() call exposed alongside (or instead of) the named ones.
 * Evidence: #2278 measured 14 production edges in 9 daemon files at origin/main 6e22e266d7;
 *   this table is that measurement, classified per ADR 0022.
 * Cost: attributed to the R76 rule registration in check.ts; not a standalone CI job.
 * Kill criterion: the daemon reaches the platform only through the gateway and declared
 *   contract capabilities (the inventory empty), or a maintainer decision retires the
 *   classification requirement.
 */
export function checkDaemonPlatformRuntimeInventory(
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  const actual = new Map<
    string,
    { line: number; symbols: Set<string>; residue: boolean; openEnded: boolean }
  >();
  for (const edge of edges) {
    if (!edge.file.startsWith('src/daemon/')) continue;
    if (!isProductionSourceFile(edge.file)) continue;
    if (!isRootPlatformRuntimeTarget(edge.target)) continue;
    const key = keyOf(edge.file, edge.target);
    const entry = actual.get(key) ?? {
      line: edge.line,
      symbols: new Set<string>(),
      residue: false,
      openEnded: false,
    };
    for (const symbol of edge.symbols) entry.symbols.add(symbol);
    entry.residue = entry.residue || edge.bindingResidue;
    // Validated per edge before the per-pair union: a dynamic import that names no binding
    // exposes the whole module namespace, which sibling named edges of the same pair would
    // otherwise mask inside the union.
    entry.openEnded =
      entry.openEnded || (edge.dynamic && !edge.bindingResidue && edge.symbols.length === 0);
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
    if (entry.residue) {
      violations.push({
        rule: DAEMON_PLATFORM_RUNTIME_RULE,
        file: key.split(' -> ')[0]!,
        line: entry.line,
        message:
          `unnameable dynamic-import binding for ${key}: a rest or computed destructure exposes ` +
          `bindings the inventory cannot name. Destructure every binding explicitly and record it ` +
          `in DAEMON_PLATFORM_RUNTIME_EDGES (${DAEMON_PLATFORM_RUNTIME_RULE}), or remove the coupling.`,
      });
      continue;
    }
    if (entry.openEnded) {
      violations.push({
        rule: DAEMON_PLATFORM_RUNTIME_RULE,
        file: key.split(' -> ')[0]!,
        line: entry.line,
        message:
          `open-ended dynamic import for ${key}: a namespace or side-effect import() exposes the ` +
          `whole module, which the inventory cannot name symbol by symbol. Destructure every ` +
          `binding explicitly and record it in DAEMON_PLATFORM_RUNTIME_EDGES ` +
          `(${DAEMON_PLATFORM_RUNTIME_RULE}), or remove the coupling.`,
      });
      continue;
    }
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
