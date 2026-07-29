import path from 'node:path';
import { SESSION_STATE_FIELD_OWNERS, STORE_OWNED_SESSION_STATE_FIELDS } from './session-state.ts';
import { targetDagZone, type ResolvedImportEdge } from './model.ts';

export type LayeringViolation = {
  rule: string;
  file: string;
  line: number;
  message: string;
};

export const DAEMON_MODULARITY_BASELINE = {
  sessionState: {
    writerOwnedFields: 30,
    ownerFileClaims: 42,
  },
  largestTypeCycle: {
    size: 102,
    zoneMembers: {
      '(root)': 5,
      client: 1,
      commands: 33,
      contracts: 2,
      core: 12,
      'daemon-server': 30,
      platforms: 19,
    },
  },
  externalDaemonTypesImporters: [
    'src/client/client-normalizers.ts',
    'src/compat/maestro/daemon-runtime-port-support.ts',
    'src/compat/maestro/daemon-runtime-public-operation.ts',
    'src/remote/daemon-artifacts.ts',
  ],
} as const;

export const TYPE_CYCLE_BASELINE = DAEMON_MODULARITY_BASELINE.largestTypeCycle.size;

type LogicalModulePolicy = {
  name: string;
  roots: readonly string[];
  forbiddenTargetRoots: readonly string[];
};

/**
 * Zero-count targets for the accepted daemon modularity design. A root may be absent today:
 * the policy starts enforcing as soon as the first file is added, without scaffolding an empty
 * façade or package merely to make the gate concrete.
 */
export const LOGICAL_MODULE_POLICIES: readonly LogicalModulePolicy[] = [
  {
    name: 'ad-replay',
    roots: ['src/ad-replay/'],
    forbiddenTargetRoots: [
      'src/daemon/',
      'src/platforms/',
      'src/providers/',
      'src/compat/',
      'src/maestro/',
    ],
  },
  {
    name: 'maestro',
    roots: ['src/maestro/'],
    forbiddenTargetRoots: ['src/daemon/', 'src/platforms/', 'src/providers/', 'src/ad-replay/'],
  },
  {
    name: 'replay-test',
    roots: ['src/replay/test/'],
    forbiddenTargetRoots: [
      'src/daemon/',
      'src/platforms/',
      'src/providers/',
      'src/ad-replay/internal/',
      'src/maestro/internal/',
    ],
  },
];

const ENGINE_FILE_PREFIXES = [
  'src/ad-replay/',
  'src/maestro/',
  'src/replay/',
  'src/compat/maestro/',
  'src/daemon/handlers/session-replay',
  'src/daemon/handlers/session-test',
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
  if (members.length > baseline.size) {
    violations.push({
      rule: 'R9 type-cycle-growth',
      file: 'scripts/layering/daemon-modularity.ts',
      line: 1,
      message: `the largest type-level import cycle grew to ${members.length} files (baseline ${baseline.size}). Declare the shared type below both modules.`,
    });
  }

  const zoneCounts = countBy(members, targetDagZone);
  for (const [zone, count] of zoneCounts) {
    const allowed = baseline.zoneMembers[zone as keyof typeof baseline.zoneMembers] ?? 0;
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
        'external production imports of daemon/types.ts may only shrink from the recorded four. Use an existing neutral contract; do not move DaemonRequest into contracts to satisfy this gate.',
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
    if (sourceModule.forbiddenTargetRoots.some((root) => edge.target.startsWith(root))) {
      violations.push({
        rule: 'R10 daemon-modularity',
        file: edge.file,
        line: edge.line,
        message: `${sourceModule.name} must not import ${edge.target}; communicate through its façade and a narrow port with two real adapters.`,
      });
      continue;
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
  const cycle = DAEMON_MODULARITY_BASELINE.largestTypeCycle;
  return (
    `R10 pins R7 at ${session.writerOwnedFields} writer-owned fields / ` +
    `${session.ownerFileClaims} owner claims, R9 at ${cycle.size} files with zone ceilings, ` +
    `${DAEMON_MODULARITY_BASELINE.externalDaemonTypesImporters.length} external daemon/types.ts importers, ` +
    'and zero forbidden logical-module imports'
  );
}

export function sessionStateFieldCount(): number {
  return Object.keys(SESSION_STATE_FIELD_OWNERS).length + STORE_OWNED_SESSION_STATE_FIELDS.size;
}
