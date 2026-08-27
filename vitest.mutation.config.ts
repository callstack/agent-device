import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { readTestScope, threadHostileTestFiles } from './scripts/mutation/test-scope.ts';
import { workspaceSourceAliases } from './scripts/mutation/workspace-aliases.ts';
import { SERIALIZED_TESTS, SETUP_FILES } from './vitest.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Every `@agent-device/*` specifier must resolve to source inside the sandbox,
// or mutants load from the real tree through pnpm's node_modules link. Entries
// come from the exports-map reader, never a wildcard, so this cannot reach
// package internals (R11).
const inStrykerSandbox = repoRoot.includes(path.join('.tmp', 'stryker'));
const workspaceAliases = workspaceSourceAliases(
  repoRoot,
  inStrykerSandbox ? 'disk-manifests' : 'tracked-manifests',
);

// The per-run scope arrives through AGENT_DEVICE_MUTATION_TEST_FILES; the
// unit suite is the fallback that keeps `pnpm exec stryker run` usable by hand.
const scope = readTestScope();

export default defineConfig({
  resolve: {
    alias: workspaceAliases,
  },
  test: {
    include: scope ?? ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    exclude: [...SERIALIZED_TESTS, ...threadHostileTestFiles(repoRoot), '**/node_modules/**'],
    setupFiles: [...SETUP_FILES],
  },
});
