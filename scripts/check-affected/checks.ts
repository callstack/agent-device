// Catalog for the check-affected selector: how each derived CheckId maps to a
// runnable command and the authoritative GitHub CI job(s) it mirrors.
//
// Commands are resolved from real package.json scripts or Vitest's native
// affected-test command, so this stays a thin projection over existing
// aggregate checks rather than a second source of truth for how to run them.

import { ALL_CHECKS, type CheckId } from './model.ts';

export type CheckKind =
  | { readonly type: 'script'; readonly script: string }
  | { readonly type: 'vitest-related' };

export type CheckSpec = {
  readonly id: CheckId;
  readonly label: string;
  readonly kind: CheckKind;
  readonly ciJobs: readonly string[];
  // Whether `--run` should attempt the check locally. Device/emulator lanes and
  // network/toolchain-gated lanes stay authoritative on GitHub CI.
  readonly localRunnable: boolean;
};

export const CHECK_CATALOG: readonly CheckSpec[] = [
  {
    id: 'format',
    label: 'Formatting (oxfmt)',
    kind: { type: 'script', script: 'format:check' },
    ciJobs: ['Lint & Format'],
    localRunnable: true,
  },
  {
    id: 'lint',
    label: 'Lint (oxlint)',
    kind: { type: 'script', script: 'lint' },
    ciJobs: ['Lint & Format'],
    localRunnable: true,
  },
  {
    id: 'typecheck',
    label: 'Typecheck (tsc)',
    kind: { type: 'script', script: 'typecheck' },
    ciJobs: ['Typecheck'],
    localRunnable: true,
  },
  {
    id: 'layering',
    label: 'Import-direction layering guard',
    kind: { type: 'script', script: 'check:layering' },
    ciJobs: ['Layering Guard'],
    localRunnable: true,
  },
  {
    id: 'fallow',
    label: 'Fallow code-quality audit',
    kind: { type: 'script', script: 'check:fallow' },
    ciJobs: ['Fallow Code Quality'],
    localRunnable: true,
  },
  {
    id: 'mcp-metadata',
    label: 'MCP registry metadata sync',
    kind: { type: 'script', script: 'check:mcp-metadata' },
    ciJobs: ['Typecheck'],
    localRunnable: true,
  },
  {
    id: 'build',
    label: 'Build (tsdown + declarations)',
    kind: { type: 'script', script: 'build' },
    ciJobs: ['Packaged CLI Node 22.12'],
    localRunnable: true,
  },
  {
    id: 'vitest-related',
    label: 'Tests related by Vitest module graph',
    kind: { type: 'vitest-related' },
    ciJobs: ['Coverage'],
    localRunnable: true,
  },
  {
    id: 'unit',
    label: 'Unit + smoke suite',
    kind: { type: 'script', script: 'check:unit' },
    ciJobs: ['Coverage', 'Integration Tests'],
    localRunnable: true,
  },
  {
    id: 'coverage',
    label: 'Coverage + provider integration suite',
    kind: { type: 'script', script: 'test:coverage' },
    ciJobs: ['Coverage'],
    localRunnable: true,
  },
  {
    id: 'provider-integration',
    label: 'Provider-backed integration suite',
    kind: { type: 'script', script: 'test:integration:provider' },
    ciJobs: ['Integration Tests', 'Coverage'],
    localRunnable: true,
  },
  {
    id: 'integration-node',
    label: 'Node integration smoke',
    kind: { type: 'script', script: 'test:integration:node' },
    ciJobs: ['Integration Tests'],
    localRunnable: true,
  },
  {
    id: 'integration-progress',
    label: 'Integration architecture-progress gate',
    kind: { type: 'script', script: 'test:integration:progress:check' },
    ciJobs: ['Integration Tests'],
    localRunnable: true,
  },
  {
    id: 'swift-runner',
    label: 'Swift runner build',
    kind: { type: 'script', script: 'build:xcuitest' },
    ciJobs: ['Swift Runner Unit Compile', 'iOS / Smoke Tests', 'macOS / Smoke Tests'],
    localRunnable: false,
  },
  {
    id: 'android-helpers',
    label: 'Android helper builds',
    kind: { type: 'script', script: 'build:android-snapshot-helper' },
    ciJobs: ['Android / Smoke Tests'],
    localRunnable: false,
  },
  {
    id: 'macos-helper',
    label: 'macOS helper build',
    kind: { type: 'script', script: 'build:macos-helper' },
    ciJobs: ['macOS / Smoke Tests'],
    localRunnable: false,
  },
  {
    id: 'web-smoke',
    label: 'Live web platform smoke',
    kind: { type: 'script', script: 'test:smoke:web' },
    ciJobs: ['Web Platform Smoke'],
    localRunnable: false,
  },
  {
    id: 'skillgym',
    label: 'SkillGym command-planning suite',
    kind: { type: 'script', script: 'test:skillgym' },
    // No GitHub workflow runs SkillGym; per the AGENTS.md testing matrix it is
    // a local-only gate (`pnpm test:skillgym`). Keep it locally runnable rather
    // than claiming a CI job that does not exist and silently skipping it.
    ciJobs: [],
    localRunnable: true,
  },
];

export function getCheckSpec(id: CheckId): CheckSpec {
  const spec = CHECK_CATALOG.find((entry) => entry.id === id);
  if (!spec) throw new Error(`No catalog entry for check "${id}".`);
  return spec;
}

// Resolve the runnable command for a check. Script-backed checks are validated
// against package.json so a renamed/removed script fails loudly instead of
// silently skipping a gate. `fallow` threads the same --base the audit uses.
export function resolveCommand(
  spec: CheckSpec,
  scripts: Readonly<Record<string, string>>,
  base: string,
  changedFiles: readonly string[] = [],
): string[] {
  if (spec.kind.type === 'vitest-related') {
    return ['pnpm', 'exec', 'vitest', 'related', '--run', '--passWithNoTests', ...changedFiles];
  }
  const { script } = spec.kind;
  if (!(script in scripts)) {
    throw new Error(
      `Check "${spec.id}" references package.json script "${script}", which does not exist.`,
    );
  }
  const command = ['pnpm', 'run', script];
  if (spec.id === 'fallow') command.push('--base', base);
  return command;
}

// Guard: the catalog must cover exactly the CheckId universe. The self-test
// asserts this so a new check cannot ship half-wired.
export function assertCatalogComplete(): void {
  const catalogIds = new Set(CHECK_CATALOG.map((entry) => entry.id));
  const missing = ALL_CHECKS.filter((id) => !catalogIds.has(id));
  const extra = CHECK_CATALOG.filter((entry) => !ALL_CHECKS.includes(entry.id)).map((e) => e.id);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `Check catalog out of sync with ALL_CHECKS. Missing: [${missing.join(', ')}]; ` +
        `extra: [${extra.join(', ')}].`,
    );
  }
}
