// Enumerated decision kernels the mutation lane measures (issue #1415).
//
// Mutation score is the only mechanical answer to "is this test load-bearing or
// decorative", but a full-suite sweep is unaffordable. This registry is the
// single source of truth for what Stryker mutates: `stryker.config.json`'s
// `mutate` globs are asserted against it, and PR-affected selection maps changed
// files onto modules through it.
//
// Membership rule: pure decision kernels only — a surviving mutant here means a
// silently wrong agent-facing decision. Anything that spawns subprocesses or
// waits real time is out of scope by construction (its mutants would be timeout
// noise, not test-strength signal).

export type ModuleId =
  | 'kernel-errors'
  | 'daemon-ref-frame'
  | 'interaction-settle'
  | 'scroll-edge-state'
  | 'selectors'
  | 'target-annotation-serde'
  | 'snapshot-occlusion';

export type KernelModule = {
  readonly id: ModuleId;
  readonly label: string;
  /** Globs handed to Stryker's `mutate`. */
  readonly mutate: readonly string[];
  /**
   * Paths this module owns; a trailing `/` marks a directory prefix. Sources
   * only — the tests whose strength the score measures are derived from the
   * import graph in `ownership.ts`, never listed here.
   */
  readonly owns: readonly string[];
  /**
   * How many parallel jobs the module's mutants are sliced across. One job per
   * module is the default; a module big enough to outrun the lane's 30-minute
   * budget declares more (`--shard i/n` picks the slice).
   */
  readonly shards?: number;
};

export const KERNEL_MODULES: readonly KernelModule[] = [
  {
    id: 'kernel-errors',
    label: 'Error retriability + hints',
    mutate: ['packages/kernel/src/errors.ts'],
    owns: ['packages/kernel/src/errors.ts'],
  },
  {
    id: 'daemon-ref-frame',
    label: 'Ref-frame admission matrix (ADR 0014)',
    mutate: ['src/daemon/ref-frame.ts'],
    owns: ['src/daemon/ref-frame.ts'],
  },
  {
    id: 'interaction-settle',
    label: 'Interaction settle decisions',
    mutate: ['src/commands/interaction/runtime/settle.ts'],
    owns: ['src/commands/interaction/runtime/settle.ts'],
  },
  {
    id: 'scroll-edge-state',
    label: 'Scroll edge-state detection',
    mutate: ['src/utils/scroll-edge-state.ts'],
    owns: ['src/utils/scroll-edge-state.ts'],
  },
  {
    id: 'selectors',
    label: 'Selector parsing + matching',
    mutate: [
      'packages/selectors/src/**/*.ts',
      '!packages/selectors/src/**/*.test.ts',
      '!packages/selectors/src/internal/__tests__/**',
    ],
    // Selector tests live under the owned package source, so the prefix covers them.
    owns: ['packages/selectors/src/'],
    // ~1,280 mutants at the observed ~3s/mutant on a 2-core runner is ~64
    // minutes in one job — past the acceptance budget and its own timeout.
    shards: 4,
  },
  {
    id: 'target-annotation-serde',
    label: 'Target-annotation comment-line codec (ADR 0012 decision 3)',
    mutate: ['packages/ad-script/src/internal/target-annotation-serde.ts'],
    owns: ['packages/ad-script/src/internal/target-annotation-serde.ts'],
  },
  {
    id: 'snapshot-occlusion',
    label: 'Snapshot occlusion (covered/not-covered) decisions',
    mutate: ['src/snapshot/snapshot-occlusion.ts'],
    owns: ['src/snapshot/snapshot-occlusion.ts'],
  },
];

export const ALL_MODULE_IDS: readonly ModuleId[] = KERNEL_MODULES.map((module) => module.id);

export function moduleById(id: ModuleId): KernelModule {
  const found = KERNEL_MODULES.find((module) => module.id === id);
  if (!found) throw new Error(`Unknown mutation module: ${id}`);
  return found;
}

export function isModuleId(value: string): value is ModuleId {
  return ALL_MODULE_IDS.includes(value as ModuleId);
}

/** Mutate globs for a module subset, in registry order. */
export function mutateGlobs(ids: readonly ModuleId[] = ALL_MODULE_IDS): string[] {
  return KERNEL_MODULES.filter((module) => ids.includes(module.id)).flatMap((module) => [
    ...module.mutate,
  ]);
}

/**
 * The module a lane-tooling change proves itself against. `kernel-errors` is the
 * cheapest real sweep in the registry (one file, ~183 mutants), so a change to
 * the harness or the config runs actual mutants end to end without paying for
 * the full sweep.
 */
export const LANE_CANARY: ModuleId = 'kernel-errors';

/** One mutation job: a module, optionally one slice of it. */
export type ShardSpec = { name: string; module: ModuleId; shard?: string };

/**
 * The jobs a module set expands into. Both workflows' matrices are this list, so
 * a registry module (or a change to its shard count) can never leave the sweep
 * without the workflow assertions noticing.
 */
export function shardMatrix(ids: readonly ModuleId[] = ALL_MODULE_IDS): ShardSpec[] {
  return KERNEL_MODULES.filter((module) => ids.includes(module.id)).flatMap((module) => {
    const count = module.shards ?? 1;
    if (count === 1) return [{ name: module.id, module: module.id }];
    return Array.from({ length: count }, (_unused, index) => ({
      name: `${module.id}-${index + 1}`,
      module: module.id,
      shard: `${index + 1}/${count}`,
    }));
  });
}

export function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Where the mutation lane can ever find a kernel's owning test: root `src/` or
 * a workspace package's `src/` — the same two roots `unit-core`'s `include`
 * (`vitest.config.ts`) draws tests from. A kernel whose test lives outside
 * both (e.g. `scripts/__tests__`) is unreachable by construction, not silently
 * dropped.
 */
const KERNEL_TEST_FILE_RE = /^(?:src\/|packages\/[^/]+\/src\/).*\.test\.ts$/;

export function isKernelTestFile(filePath: string): boolean {
  return KERNEL_TEST_FILE_RE.test(normalizePath(filePath));
}

/**
 * Which kernel module owns a repository-relative *source* path, if any.
 *
 * Test-file attribution is derived from the import graph — see
 * `derivedAffectedModules` in `ownership.ts`, which is what the PR lane calls.
 */
export function moduleForFile(filePath: string): ModuleId | undefined {
  const normalized = normalizePath(filePath);
  for (const module of KERNEL_MODULES) {
    for (const owned of module.owns) {
      const match = owned.endsWith('/') ? normalized.startsWith(owned) : normalized === owned;
      if (match) return module.id;
    }
  }
  return undefined;
}

/** Kernel modules whose registry-owned paths a diff touches. */
export function affectedModules(changedFiles: readonly string[]): ModuleId[] {
  const ids = new Set<ModuleId>();
  for (const file of changedFiles) {
    const id = moduleForFile(file);
    if (id) ids.add(id);
  }
  return KERNEL_MODULES.filter((module) => ids.has(module.id)).map((module) => module.id);
}
