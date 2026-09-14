import { isProductionSourceFile } from './tracked-sources.ts';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';

// The classified inventory of every production daemon import that reaches the root platform-runtime
// composition modules (#2278, ADR 0022, #2542). R65 already bans daemon imports of concrete platform
// packages and the retired src/platforms zone; the composition layer is the one place the daemon may
// still touch, and this table is the classification of every edge that reaches it — either directly
// into the src/platform-runtime*.ts family, or into any module outside the daemon zone that imports
// that family itself, statically or dynamically. A root hub such as src/provider-device-runtime.ts is
// named by neither file pattern nor zone, so a daemon import of it used to be invisible here while
// carrying the same platform mechanics. An edge is unclassifiable until it is recorded here with a
// rationale, and a recorded edge that no longer exists is stale — both fail, so the inventory and the
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
 * Every module outside the daemon zone through which a daemon import can reach the root
 * platform-runtime family: the family itself, plus anything that imports it, transitively, over
 * static and dynamic edges alike. Computed from the tree rather than patterned so a root hub that
 * carries platform mechanics without naming them gains no immunity from its filename, and so a
 * dynamic edge out of the daemon zone is caught like a static one instead of escaping the
 * inventory (#2542).
 */
export function computePlatformMechanicsHubs(
  edges: readonly ResolvedImportEdge[],
): ReadonlySet<string> {
  const importersByTarget = new Map<string, string[]>();
  const roots: string[] = [];
  for (const edge of edges) {
    const importers = importersByTarget.get(edge.target);
    if (importers === undefined) importersByTarget.set(edge.target, [edge.file]);
    else importers.push(edge.file);
    if (isRootPlatformRuntimeTarget(edge.target) && !roots.includes(edge.target)) {
      roots.push(edge.target);
    }
  }

  const hubs = new Set<string>(roots);
  const seen = new Set<string>(roots);
  const frontier = [...roots];
  while (frontier.length > 0) {
    for (const importer of importersByTarget.get(frontier.pop()!) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      frontier.push(importer);
      if (!importer.startsWith('src/daemon/')) hubs.add(importer);
    }
  }
  return hubs;
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
    file: 'src/daemon/session-lifecycle/internal/session-open-execution.ts',
    target: 'src/platform-runtime-device-boot.ts',
    symbols: ['deviceBootObservation'],
    classification: 'daemon-policy-essential',
    rationale:
      'daemon-owned claim reconciliation asks the device when it last booted to decide whether a ' +
      'foreign claim can still describe live ownership; the per-family probe mechanics stay in the ' +
      'Apple and Android packages behind the neutral observation contract (#2538).',
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
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/core/interactors.ts',
    symbols: ['getInteractor'],
    classification: 'composition-essential',
    rationale:
      'process-root assembly of the neutral InteractorResolution capability the legacy snapshot ' +
      'capture consumes (#2555): this site hands the shared interactor lookup to the daemon next ' +
      "to the provider-device admission it shares a request scope with, and is the daemon zone's " +
      'only edge into src/core/interactors.ts. The lookup it replaced was a dynamic import out of ' +
      'the daemon zone, a direction the ranked spine cannot see.',
  },
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/provider-device-runtimes.ts',
    symbols: ['createDefaultProviderRuntimeComposition', 'DEFAULT_PROVIDER_RUNTIME_REQUIRED_IDS'],
    classification: 'composition-essential',
    rationale:
      'process-root assembly of the default provider runtime composition and the ids whose runtime ' +
      'must be present for a request, which is what makes a cloud or remote lease holder visible to ' +
      'the daemon at all; the daemon holds no provider mechanics at this site.',
  },
  {
    file: 'src/daemon/server/daemon-runtime.ts',
    target: 'src/provider-device-runtime.ts',
    symbols: ['createProviderDeviceRuntimeRequestProviders', 'isActiveProviderDevice'],
    classification: 'composition-essential',
    rationale:
      'process-root assembly of the request-scoped provider runtime providers, and the one site that ' +
      'hands the resulting device-ownership fact to the daemon through its own typed admission seam ' +
      '(#2541); the ten leaf call sites that used to name this hub now read ' +
      'src/daemon/provider-device-admission.ts, so this edge is the composition and nothing else.',
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
 * Catches: unclassified daemon-to-platform-mechanics coupling regrowing — a new edge (or a
 *   new symbol on an existing edge) that the #2278 audit never classified, the mirror failure, a
 *   classified edge that no longer exists and would silently admit its return, and dynamic
 *   imports whose binding set the inventory cannot name: a rest or computed destructure binding,
 *   or a namespace/side-effect import() call exposed alongside (or instead of) the named ones.
 *   Reaching the platform through a root hub is caught the same way as reaching it directly, and a
 *   dynamic edge is classified rather than skipped, so the direction the ranked spine cannot see is
 *   at least named here (#2542).
 * Evidence: #2278 measured 14 production edges in 9 daemon files at origin/main 6e22e266d7;
 *   this table is that measurement, classified per ADR 0022, plus the 3 edges the hub widening and
 *   dynamic-edge pass made visible at #2541 (2 provider-runtime hubs, 1 dynamic interactor lookup
 *   that #2555 has since composed away into the daemon-runtime edge above).
 * Cost: attributed to the R76 rule registration in check.ts; not a standalone CI job.
 * Kill criterion: the daemon reaches the platform only through the gateway and declared
 *   contract capabilities (the inventory empty), or a maintainer decision retires the
 *   classification requirement.
 */
export function checkDaemonPlatformRuntimeInventory(
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  const hubs = computePlatformMechanicsHubs(edges);
  const actual = new Map<
    string,
    { line: number; symbols: Set<string>; residue: boolean; openEnded: boolean }
  >();
  for (const edge of edges) {
    if (!edge.file.startsWith('src/daemon/')) continue;
    if (!isProductionSourceFile(edge.file)) continue;
    if (!hubs.has(edge.target)) continue;
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
          `unclassified daemon coupling to platform mechanics: ${key}. Classify it in ` +
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
