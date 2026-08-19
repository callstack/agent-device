import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { readTestScope, threadHostileTestFiles } from './scripts/mutation/test-scope.ts';
import { workspaceSourceAliases } from './scripts/mutation/workspace-aliases.ts';
import { SETUP_FILES, SUBPROCESS_STUB_TESTS } from './vitest.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Workspace-package aliases for the Stryker sandbox (#1490 W0). Stryker copies
// the tree into .stryker-tmp and symlinks node_modules back to the real repo,
// so a `@agent-device/*` specifier resolved through pnpm's link escapes the
// sandbox: mutants written into the sandbox copy never load, and
// `vitest related` finds no tests for a mutated package file. Aliasing each
// EXPORTED specifier to its source file — resolved relative to this config,
// which Stryker copies into the sandbox — keeps resolution inside the mutated
// tree. Entries come from the shared exports-map reader, never a wildcard, so
// this cannot resolve package internals the boundary forbids (R11).
const workspaceAliases = workspaceSourceAliases(repoRoot);

// Test scope for the decision-kernel mutation lane (issue #1415).
//
// `scripts/mutation/run.ts` derives the per-run scope from Vitest's module graph
// (`vitest related` over the mutated files) and hands it over through
// AGENT_DEVICE_MUTATION_TEST_FILES; the fallback is the deterministic unit suite,
// which keeps `pnpm exec stryker run` usable by hand. Excluded either way: the
// subprocess-stub group and the CLI-capture tests — see
// scripts/mutation/test-scope.ts for why, and why excluding them cannot hide a
// surviving mutant.
const scope = readTestScope();

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    include: scope ?? ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: [...SUBPROCESS_STUB_TESTS, ...threadHostileTestFiles(repoRoot), '**/node_modules/**'],
    setupFiles: [...SETUP_FILES],
  },
});
