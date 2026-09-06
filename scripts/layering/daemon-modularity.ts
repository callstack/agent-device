import path from 'node:path';
import {
  INTERACTION_RETIRED_HANDLER_PATHS,
  LOGICAL_MODULE_POLICIES,
  matchesDeclaredRoot,
  SESSION_LIFECYCLE_RETIRED_HANDLER_PATHS,
  SESSION_OBSERVABILITY_RETIRED_HANDLER_PATHS,
  SNAPSHOT_EXECUTION_RETIRED_HANDLER_PATHS,
  type LogicalModulePolicy,
} from './architecture-ownership.ts';
import { targetDagZone, type LayeringViolation, type ResolvedImportEdge } from './model.ts';
import type { LayeringRatchets } from './ratchet-reference.ts';

// R7 ownership pressure and the largest type cycle (whole and per zone) are ratcheted against the
// merge-base with origin/main (`ratchet-reference.ts`); the importer membership below stays a
// recorded list, because it names files rather than counting them.
export const DAEMON_MODULARITY_BASELINE = {
  externalDaemonTypesImporters: [
    'src/client/client-normalizers.ts',
    // #2342 relocated the daemon client to `src/daemon-client/`. These five edges are unchanged
    // by that move — the client has always built `DaemonRequest` and read `DaemonResponse`, it
    // simply sat inside `src/daemon/` and so fell under the prefix skip below. Naming the files
    // is stronger than letting a folder prefix hide them: the set can only shrink, so a new
    // `src/daemon-client/` module reaching `session-state.ts` or the daemon-private request half
    // still fails this gate. Reducing these five means giving the client a neutral request
    // contract, which is a type change, not a relocation.
    'src/daemon-client/daemon-client-lifecycle.ts',
    'src/daemon-client/daemon-client-progress.ts',
    'src/daemon-client/daemon-client-rpc.ts',
    'src/daemon-client/daemon-client-transport.ts',
    'src/daemon-client/daemon-client.ts',
    'src/remote/daemon-artifacts.ts',
  ],
} as const;

// The modules that own the daemon's dispatch vocabulary since #2338 split `daemon/types.ts`:
// the request shape, its wire-only half, and the live session record. All three are ratcheted
// together, so moving a symbol between them cannot reopen the boundary to a new outside zone.
const DAEMON_TYPE_MODULES: readonly string[] = [
  'src/daemon/daemon-request.ts',
  'src/daemon/daemon-request-wire.ts',
  'src/daemon/session-state.ts',
];

const ENGINE_FILE_PREFIXES = [
  'packages/ad-replay/src/',
  'packages/maestro/src/',
  'src/daemon/replay/internal/',
  'packages/replay-test/src/',
] as const;

/**
 * Catches: the daemon modularity migration regressing quietly — a SessionState field losing
 *   its owner, a logical module gaining a forbidden or internal import, or an external
 *   external daemon request/session-state importer count creeping up — any of which erodes the wave-by-wave
 *   extraction #1478/#1478-P5 already paid for, and nothing enforces the wave order itself.
 * Evidence: 2316fd32c5 (#1487) pinned the migration contracts this ratchet grew from;
 *   6984a1e095 (#1852) fixed the R10 zone-listing message when the type-cycle ceiling trips.
 * Cost: 937 LOC total for the file (323 rule + 614 test; shared with R9's checkTypeCycleBaseline
 *   below, not attributed separately).
 * Kill criterion: none enforced today; retire only by maintainer decision that the daemon
 *   modularity measurements (SessionState field-owner counts, logical-module import policies and
 *   facades, the external daemon request/session-state importer list, per-zone cycle membership) no longer
 *   matter. Every one is a count or an import edge the compiler accepts either way.
 */
export function checkDaemonModularityRatchets(
  edges: readonly ResolvedImportEdge[],
  measured: LayeringRatchets,
  reference: LayeringRatchets,
): LayeringViolation[] {
  return [
    ...checkSessionStateBaseline(measured.sessionState, reference.sessionState),
    ...checkTypeCycleBaseline(measured.largestTypeCycle, reference.largestTypeCycle),
    ...checkDaemonTypesImporters(edges),
    ...checkLogicalModuleImports(edges),
  ];
}

export function checkRetiredSessionLifecyclePaths(
  sourceFiles: readonly string[],
): LayeringViolation[] {
  return checkRetiredHandlerPaths(
    sourceFiles,
    SESSION_LIFECYCLE_RETIRED_HANDLER_PATHS,
    /^src\/daemon\/handlers\/session-(?:open|close)(?:-[^/]+)?\.ts$/,
    'session lifecycle',
  );
}

export function checkRetiredSessionObservabilityPaths(
  sourceFiles: readonly string[],
): LayeringViolation[] {
  return checkRetiredHandlerPaths(
    sourceFiles,
    SESSION_OBSERVABILITY_RETIRED_HANDLER_PATHS,
    /^src\/daemon\/handlers\/session-(?:observability|perf|logs|events|network|audio)(?:-[^/]+)?\.ts$/,
    'session observability',
  );
}

export function checkRetiredSnapshotExecutionPaths(
  sourceFiles: readonly string[],
): LayeringViolation[] {
  return checkRetiredHandlerPaths(
    sourceFiles,
    SNAPSHOT_EXECUTION_RETIRED_HANDLER_PATHS,
    /$^/,
    'snapshot execution handler',
    'Reuse the daemon-owned snapshot execution module instead of restoring shared mechanics beneath a route adapter.',
  );
}

function checkRetiredHandlerPaths(
  sourceFiles: readonly string[],
  retiredPaths: readonly string[],
  pattern: RegExp,
  capability: string,
  guidance = 'Keep the neutral seam at its daemon owner instead of rebuilding a handler grab-bag.',
): LayeringViolation[] {
  return sourceFiles
    .filter((file) => retiredPaths.includes(file) || pattern.test(file))
    .map((file) => ({
      rule: 'R10 daemon-modularity',
      file,
      line: 1,
      message: `retired ${capability} path was restored: ${file}. ` + guidance,
    }));
}

export function checkRetiredInteractionPaths(sourceFiles: readonly string[]): LayeringViolation[] {
  return checkRetiredHandlerPaths(
    sourceFiles,
    INTERACTION_RETIRED_HANDLER_PATHS,
    /^src\/daemon\/handlers\/(?:find|interaction)(?:-[^/]+)?\.ts$/,
    'interaction handler',
    'Keep route implementations behind src/daemon/interaction/index.ts instead of rebuilding a handler-owned interaction surface.',
  );
}

function checkSessionStateBaseline(
  measured: LayeringRatchets['sessionState'],
  reference: LayeringRatchets['sessionState'],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const metric of ['writerOwnedFields', 'ownerFileClaims'] as const) {
    if (measured[metric] <= reference[metric]) continue;
    violations.push({
      rule: 'R10 daemon-modularity',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        `R7 ${metric} grew to ${measured[metric]} (baseline ${reference[metric]} at the ` +
        `merge-base). Route the new write through an existing owner instead.`,
    });
  }
  return violations;
}

/**
 * Catches: the largest type-only import cycle growing past what the merge-base holds, whole or
 *   in any one zone — R4 keeps the value graph acyclic, so these cycles cost nothing at runtime,
 *   but an ungoverned type cycle can grow without bound while every individual edge still looks
 *   locally reasonable.
 * Evidence: 6984a1e095 (#1852) fixed R10's zone listing when this ceiling trips, evidence the
 *   check fires in practice; ef6ec2995b (#1825, #1781 A6) made a banked shrink mandatory rather
 *   than advisory, which measuring the merge-base now does without an edit.
 * Cost: 937 LOC total for the file (323 rule + 614 test; shared with R10's ratchets above, not
 *   attributed separately).
 * Kill criterion: none enforced today; retire only by maintainer decision that a bounded
 *   type-only cycle size no longer matters. tsc never rejects a type-only cycle, and a merge-base
 *   with no cycle pins the size at zero rather than retiring the check.
 */
function checkTypeCycleBaseline(
  members: readonly string[],
  referenceMembers: readonly string[],
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  if (members.length > referenceMembers.length) {
    violations.push({
      rule: 'R9 type-cycle-size',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        `the largest type-level import cycle grew to ${members.length} files (baseline ` +
        `${referenceMembers.length} at the merge-base). A type-only import that closes a loop makes ` +
        `every file in the loop unreadable in isolation. Declare the shared type below both modules.`,
    });
  }

  const referenceByZone = groupBy(referenceMembers, targetDagZone);
  for (const [zone, zoneMembers] of groupBy(members, targetDagZone)) {
    const referenceZoneMembers = new Set(referenceByZone.get(zone) ?? []);
    const allowed = referenceZoneMembers.size;
    if (zoneMembers.length <= allowed) continue;
    // A ceiling recorded a count, so the gate could only list the whole zone and #1837's
    // diagnosis landed on a file that had been in the cycle all along. The merge-base carries
    // membership, so the files that joined are named exactly.
    const joined = zoneMembers.filter((member) => !referenceZoneMembers.has(member));
    violations.push({
      rule: 'R10 daemon-modularity',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        `the largest type cycle now contains ${zoneMembers.length} ${zone} file(s) (baseline ` +
        `${allowed} at the merge-base); extraction must not trade one zone's locality for ` +
        `another's. ${zoneMembers.length - allowed} over the merge-base — the ${zone} file(s) ` +
        `that joined: ${joined.join(', ')}. Cut the edge that pulled them in.`,
    });
  }

  for (const member of members) {
    if (!ENGINE_FILE_PREFIXES.some((prefix) => member.startsWith(prefix))) continue;
    violations.push({
      rule: 'R10 daemon-modularity',
      file: member,
      line: 1,
      message:
        'an engine file entered the largest type cycle. Keep engine contracts neutral and adapters outside the engine so extraction does not worsen R9.',
    });
  }
  return violations;
}

function checkDaemonTypesImporters(edges: readonly ResolvedImportEdge[]): LayeringViolation[] {
  const allowed = new Set<string>(DAEMON_MODULARITY_BASELINE.externalDaemonTypesImporters);
  const importers = new Map<string, ResolvedImportEdge>();
  for (const edge of edges) {
    if (!DAEMON_TYPE_MODULES.includes(edge.target) || edge.file.startsWith('src/daemon/')) continue;
    importers.set(edge.file, edge);
  }
  const violations = [...importers]
    .filter(([file]) => !allowed.has(file))
    .map(([file, edge]) => ({
      rule: 'R10 daemon-modularity',
      file,
      line: edge.line,
      message:
        `external production imports of the daemon request/session-state modules may only shrink ` +
        `from the recorded ${allowed.size}. ` +
        'Use an existing neutral contract; do not move DaemonRequest into contracts to satisfy this gate.',
    }));
  for (const file of allowed) {
    if (importers.has(file)) continue;
    violations.push({
      rule: 'R10 daemon-modularity',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message: `${file} no longer imports a daemon request/session-state module — delete it from externalDaemonTypesImporters in the same change so the dependency cannot return.`,
    });
  }
  return violations;
}

function checkLogicalModuleImports(edges: readonly ResolvedImportEdge[]): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const edge of edges) {
    const sourceModule = moduleForFile(edge.file);
    const targetModule = moduleForFile(edge.target);
    if (
      sourceModule &&
      isInsideInternalTree(edge.file, sourceModule.roots) &&
      sourceModule.internalForbiddenTargetRoots?.some((root) =>
        matchesDeclaredRoot(edge.target, root),
      )
    ) {
      violations.push({
        rule: 'R10 daemon-modularity',
        file: edge.file,
        line: edge.line,
        message:
          `${edge.file} must not import ${edge.target} from ${sourceModule.name}'s internal tree; ` +
          'keep handler adapters above the interaction façade.',
      });
      continue;
    }
    if (
      targetModule &&
      sourceModule !== targetModule &&
      isInsideInternalTree(edge.target, targetModule.roots)
    ) {
      violations.push({
        rule: 'R10 daemon-modularity',
        file: edge.file,
        line: edge.line,
        message: `${edge.file} must not import ${targetModule.name}'s internal tree (${edge.target}); use that module's façade.`,
      });
      continue;
    }

    if (!sourceModule) continue;
    // A module's own files are never a forbidden target.
    if (sourceModule.roots.some((root) => matchesDeclaredRoot(edge.target, root))) continue;
    if (!sourceModule.forbiddenTargetRoots.some((root) => matchesDeclaredRoot(edge.target, root)))
      continue;
    violations.push({
      rule: 'R10 daemon-modularity',
      file: edge.file,
      line: edge.line,
      message: `${sourceModule.name} must not import ${edge.target}; communicate through its façade and a narrow port with two real adapters.`,
    });
  }
  return violations;
}

function moduleForFile(file: string): LogicalModulePolicy | undefined {
  return LOGICAL_MODULE_POLICIES.find((module) =>
    module.roots.some((root) => matchesDeclaredRoot(file, root)),
  );
}

function isInsideInternalTree(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => matchesDeclaredRoot(file, path.posix.join(root, 'internal/')));
}

function groupBy(
  values: readonly string[],
  keyOf: (value: string) => string,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

export function daemonModularitySummary(reference: LayeringRatchets): string {
  const session = reference.sessionState;
  return (
    `R10 holds R7 at the merge-base's ${session.writerOwnedFields} writer-owned fields / ` +
    `${session.ownerFileClaims} owner claims, R9 at its ${reference.largestTypeCycle.length} files per zone, ` +
    `${DAEMON_MODULARITY_BASELINE.externalDaemonTypesImporters.length} external daemon request/session-state importers, ` +
    'and zero forbidden logical-module imports'
  );
}
