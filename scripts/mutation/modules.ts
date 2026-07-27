// Enumerated decision kernels the mutation lane measures (issue #1415).
//
// Mutation score is the only mechanical answer to "is this test load-bearing or
// decorative", but a full-suite sweep is unaffordable. This registry is the
// single source of truth for what Stryker mutates: `stryker.config.json`'s
// `mutate` globs are asserted against it, and PR-affected gating maps changed
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
  | 'selectors';

export type KernelModule = {
  readonly id: ModuleId;
  readonly label: string;
  /** Globs handed to Stryker's `mutate`. */
  readonly mutate: readonly string[];
  /** Paths this module owns; a trailing `/` marks a directory prefix. */
  readonly owns: readonly string[];
};

export const KERNEL_MODULES: readonly KernelModule[] = [
  {
    id: 'kernel-errors',
    label: 'Error retriability + hints',
    mutate: ['src/kernel/errors.ts'],
    owns: ['src/kernel/errors.ts'],
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
    mutate: ['src/selectors/**/*.ts', '!src/selectors/**/*.test.ts', '!src/selectors/__tests__/**'],
    owns: ['src/selectors/'],
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

export function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/').replace(/^\.\//, '');
}

/**
 * Which kernel module owns a repository-relative path, if any.
 *
 * Test files under an owned root count as owned: strengthening (or weakening) a
 * kernel's tests is exactly the change whose mutation score must be re-measured.
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

/** Kernel modules affected by a diff, for PR-scoped runs. */
export function affectedModules(changedFiles: readonly string[]): ModuleId[] {
  const ids = new Set<ModuleId>();
  for (const file of changedFiles) {
    const id = moduleForFile(file);
    if (id) ids.add(id);
  }
  return KERNEL_MODULES.filter((module) => ids.has(module.id)).map((module) => module.id);
}
