import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { readTestScope, threadHostileTestFiles } from './scripts/mutation/test-scope.ts';
import { workspaceSourceAliases } from './scripts/mutation/workspace-aliases.ts';
import { MUTATION_EXCLUDED_TESTS, SETUP_FILES } from './vitest.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

const inStrykerSandbox = repoRoot.includes(path.join('.tmp', 'stryker'));
const workspaceAliases = workspaceSourceAliases(
  repoRoot,
  inStrykerSandbox ? 'disk-manifests' : 'tracked-manifests',
);

const scope = readTestScope();

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    include: scope ?? ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: [
      ...MUTATION_EXCLUDED_TESTS,
      ...threadHostileTestFiles(repoRoot),
      '**/node_modules/**',
    ],
    setupFiles: [...SETUP_FILES],
  },
});
