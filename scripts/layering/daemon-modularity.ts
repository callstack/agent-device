import path from 'node:path';
import {
  LOGICAL_MODULE_POLICIES,
  matchesDeclaredRoot,
  type LogicalModulePolicy,
} from './architecture-ownership.ts';
import { targetDagZone, type LayeringViolation, type ResolvedImportEdge } from './model.ts';
import { SESSION_STATE_FIELD_OWNERS } from './session-state.ts';

const LARGEST_TYPE_CYCLE_ZONE_CEILINGS: Readonly<Record<string, number>> = {
  // co-defined-contract pair (`capabilities.ts` ↔ `runtime.ts` and the four files they
  // pull in). The standard shrink is a third module holding the shared type.
  'provider-webdriver': 6,
};

export const DAEMON_MODULARITY_BASELINE = {
  sessionState: {
    // R60 moved `audioProbe` to store-owned. R64 does the same for the neutral `perfCapture`
    // and `lastPerfProfile` records after retiring the two platform-specific perf fields.
    writerOwnedFields: 19,
    ownerFileClaims: 22,
  },
  largestTypeCycle: {
    zoneMembers: LARGEST_TYPE_CYCLE_ZONE_CEILINGS,
  },
  externalDaemonTypesImporters: [
    'src/client/client-normalizers.ts',
    'src/remote/daemon-artifacts.ts',
  ],
} as const;

export const TYPE_CYCLE_BASELINE = Object.values(LARGEST_TYPE_CYCLE_ZONE_CEILINGS).reduce(
  (sum, count) => sum + count,
  0,
);

const ENGINE_FILE_PREFIXES = [
  'packages/ad-replay/src/',
  'packages/maestro/src/',
  'src/daemon/replay/internal/',
  'packages/replay-test/src/',
] as const;

export function checkDaemonModularityRatchets(
  edges: readonly ResolvedImportEdge[],
  largestTypeCycleMembers: readonly string[],
): LayeringViolation[] {
  return [
    ...checkSessionStateBaseline(),
    ...checkTypeCycleBaseline(largestTypeCycleMembers),
    ...checkDaemonTypesImporters(edges),
    ...checkLogicalModuleImports(edges),
  ];
}

function checkSessionStateBaseline(): LayeringViolation[] {
  const actual = {
    writerOwnedFields: Object.keys(SESSION_STATE_FIELD_OWNERS).length,
    ownerFileClaims: Object.values(SESSION_STATE_FIELD_OWNERS).reduce(
      (sum, owners) => sum + owners.length,
      0,
    ),
  };
  const violations: LayeringViolation[] = [];
  for (const metric of ['writerOwnedFields', 'ownerFileClaims'] as const) {
    const baseline = DAEMON_MODULARITY_BASELINE.sessionState[metric];
    if (actual[metric] === baseline) continue;
    violations.push({
      rule: 'R10 daemon-modularity',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        actual[metric] > baseline
          ? `R7 ${metric} grew to ${actual[metric]} (baseline ${baseline}). Route the new write through an existing owner instead.`
          : `R7 ${metric} dropped to ${actual[metric]} — lower the daemon modularity baseline in the same capability move so it cannot regrow.`,
    });
  }
  return violations;
}

function checkTypeCycleBaseline(members: readonly string[]): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  const baseline = DAEMON_MODULARITY_BASELINE.largestTypeCycle;
  if (members.length > TYPE_CYCLE_BASELINE) {
    violations.push({
      rule: 'R9 type-cycle-size',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        `the largest type-level import cycle grew to ${members.length} files (baseline ` +
        `${TYPE_CYCLE_BASELINE}). A type-only import that closes a loop makes every file in the ` +
        `loop unreadable in isolation. Declare the shared type below both modules, or if the growth ` +
        `is genuinely warranted, raise the zone ceilings in the same commit and say why.`,
    });
  } else if (members.length < TYPE_CYCLE_BASELINE) {
    // A ceiling left above the measured size is headroom a later change spends without a
    // reviewer ever seeing a number move, so the shrink is recorded in the change that earns
    // it — the same equality pin R6 and the R10 R7 counts already carry.
    violations.push({
      rule: 'R9 type-cycle-size',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        `the largest type-level import cycle dropped to ${members.length} files (baseline ` +
        `${TYPE_CYCLE_BASELINE}). Lower LARGEST_TYPE_CYCLE_ZONE_CEILINGS by the same ${TYPE_CYCLE_BASELINE - members.length} ` +
        `in this change so the cycle cannot regrow into slack nobody chose.`,
    });
  }

  const membersByZone = groupBy(members, targetDagZone);
  for (const [zone, zoneMembers] of membersByZone) {
    const allowed = baseline.zoneMembers[zone] ?? 0;
    if (zoneMembers.length <= allowed) continue;
    // The ceiling records a count, not a membership, so the gate cannot name the file that
    // joined; naming the alphabetically-first member instead sent #1837's diagnosis to a file
    // that had been in the cycle all along. List the whole zone so the joining edge is one
    // diff away from the author, who knows which of these files the change touched. The
    // overflow is net growth (a join and a departure cancel out), so it bounds nothing about
    // how many members are new — only that at least one of the listed files is.
    violations.push({
      rule: 'R10 daemon-modularity',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        `the largest type cycle now contains ${zoneMembers.length} ${zone} file(s) (baseline ` +
        `${allowed}); extraction must not trade one zone's locality for another's. ` +
        `${zoneMembers.length - allowed} over the ceiling — the member(s) that joined are among ` +
        `these ${zone} files: ${zoneMembers.join(', ')}. Cut the edge that pulled them in ` +
        `rather than raising the ceiling.`,
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
    if (edge.target !== 'src/daemon/types.ts' || edge.file.startsWith('src/daemon/')) continue;
    importers.set(edge.file, edge);
  }
  const violations = [...importers]
    .filter(([file]) => !allowed.has(file))
    .map(([file, edge]) => ({
      rule: 'R10 daemon-modularity',
      file,
      line: edge.line,
      message:
        `external production imports of daemon/types.ts may only shrink from the recorded ${allowed.size}. ` +
        'Use an existing neutral contract; do not move DaemonRequest into contracts to satisfy this gate.',
    }));
  for (const file of allowed) {
    if (importers.has(file)) continue;
    violations.push({
      rule: 'R10 daemon-modularity',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message: `${file} no longer imports daemon/types.ts — delete it from externalDaemonTypesImporters in the same change so the dependency cannot return.`,
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

export function daemonModularitySummary(): string {
  const session = DAEMON_MODULARITY_BASELINE.sessionState;
  return (
    `R10 pins R7 at ${session.writerOwnedFields} writer-owned fields / ` +
    `${session.ownerFileClaims} owner claims, R9 at ${TYPE_CYCLE_BASELINE} files with zone ceilings, ` +
    `${DAEMON_MODULARITY_BASELINE.externalDaemonTypesImporters.length} external daemon/types.ts importers, ` +
    'and zero forbidden logical-module imports'
  );
}
