import path from 'node:path';
import { targetDagZone, type LayeringViolation, type ResolvedImportEdge } from './model.ts';
import { SESSION_STATE_FIELD_OWNERS } from './session-state.ts';

const LARGEST_TYPE_CYCLE_ZONE_CEILINGS: Readonly<Record<string, number>> = {
  '(root)': 3,
  client: 1,
  commands: 14,
  core: 10,
  'daemon-server': 17,
  platforms: 2,
};

export const DAEMON_MODULARITY_BASELINE = {
  sessionState: {
    writerOwnedFields: 21,
    ownerFileClaims: 25,
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

type LogicalModulePolicy = {
  name: string;
  roots: readonly string[];
  forbiddenTargetRoots: readonly string[];
  /**
   * Imports that already violate `forbiddenTargetRoots` on the day the rule was written, recorded
   * as `source -> target`. The rule enforces immediately for everything else, so a new violation
   * cannot be added while the module waits for its extraction PR; each recorded edge must be
   * deleted from this list by the change that removes the import, and re-adding one is a diff a
   * reviewer sees.
   */
  recordedMigrationImports?: readonly string[];
};

/**
 * Zero-count targets for the accepted daemon modularity design. A root may be absent today:
 * the policy starts enforcing as soon as the first file is added, without scaffolding an empty
 * façade or package merely to make the gate concrete.
 */
export const LOGICAL_MODULE_POLICIES: readonly LogicalModulePolicy[] = [
  {
    name: 'ad-replay',
    roots: ['packages/ad-replay/src/'],
    forbiddenTargetRoots: [
      'src/daemon/',
      'src/platforms/',
      'src/providers/',
      'src/compat/',
      'packages/maestro/',
    ],
  },
  {
    name: 'maestro',
    roots: ['packages/maestro/src/'],
    forbiddenTargetRoots: [
      'src/daemon/',
      'src/platforms/',
      'src/providers/',
      'packages/ad-replay/',
    ],
  },
  {
    // Replay-test schedules and reports; it must stay format-neutral. `src/request/` is
    // request-global daemon plumbing (progress sinks, cancellation, AsyncLocalStorage), and the
    // remaining roots are engine internals — reaching into either is how a scheduler quietly
    // acquires daemon authority or an engine-specific value shape.
    name: 'replay-test',
    roots: ['packages/replay-test/src/'],
    forbiddenTargetRoots: [
      'src/daemon/',
      'src/platforms/',
      'src/providers/',
      'src/request/',
      'src/replay/',
      'src/compat/',
      'packages/maestro/',
      'packages/ad-replay/',
    ],
  },
];

const ENGINE_FILE_PREFIXES = [
  'packages/ad-replay/src/',
  'packages/maestro/src/',
  'src/replay/',
  'src/daemon/handlers/session-replay',
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
      rule: 'R9 type-cycle-growth',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message:
        `the largest type-level import cycle grew to ${members.length} files (baseline ` +
        `${TYPE_CYCLE_BASELINE}). A type-only import that closes a loop makes every file in the ` +
        `loop unreadable in isolation. Declare the shared type below both modules, or if the growth ` +
        `is genuinely warranted, raise the zone ceilings in the same commit and say why.`,
    });
  }

  const zoneCounts = countBy(members, targetDagZone);
  for (const [zone, count] of zoneCounts) {
    const allowed = baseline.zoneMembers[zone] ?? 0;
    if (count <= allowed) continue;
    violations.push({
      rule: 'R10 daemon-modularity',
      file: members.find((member) => targetDagZone(member) === zone) ?? 'scripts/layering/check.ts',
      line: 1,
      message: `the largest type cycle now contains ${count} ${zone} file(s) (baseline ${allowed}); extraction must not trade one zone's locality for another's.`,
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
  const observedMigrationImports = new Set<string>();
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
    // A module's own files are never a forbidden target: `replay-test` sits inside the wider
    // `src/replay/` engine root it may not import from.
    if (sourceModule.roots.some((root) => edge.target.startsWith(root))) continue;
    if (!sourceModule.forbiddenTargetRoots.some((root) => edge.target.startsWith(root))) continue;
    const migrationImport = `${edge.file} -> ${edge.target}`;
    if (sourceModule.recordedMigrationImports?.includes(migrationImport)) {
      observedMigrationImports.add(migrationImport);
      continue;
    }
    violations.push({
      rule: 'R10 daemon-modularity',
      file: edge.file,
      line: edge.line,
      message: `${sourceModule.name} must not import ${edge.target}; communicate through its façade and a narrow port with two real adapters.`,
    });
  }
  return [...violations, ...checkRecordedMigrationImports(observedMigrationImports)];
}

function checkRecordedMigrationImports(observed: ReadonlySet<string>): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const module of LOGICAL_MODULE_POLICIES) {
    for (const migrationImport of module.recordedMigrationImports ?? []) {
      if (observed.has(migrationImport)) continue;
      violations.push({
        rule: 'R10 daemon-modularity',
        file: 'scripts/layering/daemon-modularity.ts',
        line: 1,
        message: `${migrationImport} no longer exists — delete it from ${module.name}'s recordedMigrationImports in the same change so the import cannot return.`,
      });
    }
  }
  return violations;
}

function moduleForFile(file: string): LogicalModulePolicy | undefined {
  return LOGICAL_MODULE_POLICIES.find((module) =>
    module.roots.some((root) => file.startsWith(root)),
  );
}

function isInsideInternalTree(file: string, roots: readonly string[]): boolean {
  return roots.some((root) => file.startsWith(path.posix.join(root, 'internal/')));
}

function countBy(values: readonly string[], keyOf: (value: string) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyOf(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function daemonModularitySummary(): string {
  const session = DAEMON_MODULARITY_BASELINE.sessionState;
  const recordedMigrationImports = LOGICAL_MODULE_POLICIES.reduce(
    (sum, module) => sum + (module.recordedMigrationImports?.length ?? 0),
    0,
  );
  return (
    `R10 pins R7 at ${session.writerOwnedFields} writer-owned fields / ` +
    `${session.ownerFileClaims} owner claims, R9 at ${TYPE_CYCLE_BASELINE} files with zone ceilings, ` +
    `${DAEMON_MODULARITY_BASELINE.externalDaemonTypesImporters.length} external daemon/types.ts importers, ` +
    `and zero forbidden logical-module imports beyond ${recordedMigrationImports} recorded migration import(s)`
  );
}
