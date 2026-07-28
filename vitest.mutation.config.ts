import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { readTestScope, threadHostileTestFiles } from './scripts/mutation/test-scope.ts';
import { SUBPROCESS_STUB_TESTS } from './vitest.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

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
  test: {
    include: scope ?? ['src/**/*.test.ts'],
    exclude: [...SUBPROCESS_STUB_TESTS, ...threadHostileTestFiles(repoRoot), '**/node_modules/**'],
    setupFiles: ['src/__tests__/hermetic-env-setup.ts', 'src/__tests__/process-memo-setup.ts'],
  },
});
