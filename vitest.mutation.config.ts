import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { readTestScope, threadHostileTestFiles } from './scripts/mutation/test-scope.ts';
import { SUBPROCESS_STUB_TESTS } from './vitest.config.ts';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

// Workspace-package aliases for the Stryker sandbox (#1490 W0). Stryker copies
// the tree into .stryker-tmp and symlinks node_modules back to the real repo,
// so a `@agent-device/*` specifier resolved through pnpm's link escapes the
// sandbox: mutants written into the sandbox copy never load, and
// `vitest related` finds no tests for a mutated package file ("No tests were
// executed"). Aliasing each EXPORTED specifier to its source file — resolved
// relative to this config, which Stryker copies into the sandbox — keeps
// resolution inside the mutated tree. Entries are derived from each package's
// exports map, never a wildcard, so this cannot resolve package internals the
// boundary forbids (R11).
function workspaceExportAliases(): { find: string; replacement: string }[] {
  const aliases: { find: string; replacement: string }[] = [];
  const packagesDir = path.join(repoRoot, 'packages');
  if (!fs.existsSync(packagesDir)) return aliases;
  for (const entry of fs.readdirSync(packagesDir).sort()) {
    const manifestPath = path.join(packagesDir, entry, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      exports?: Record<string, { default?: string } | string>;
    };
    if (!manifest.name || !manifest.exports) continue;
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const file = typeof target === 'string' ? target : target.default;
      if (!file) continue;
      aliases.push({
        find: path.posix.join(manifest.name, subpath),
        replacement: path.join(packagesDir, entry, file),
      });
    }
  }
  return aliases;
}

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
    alias: workspaceExportAliases(),
  },
  test: {
    include: scope ?? ['src/**/*.test.ts'],
    exclude: [...SUBPROCESS_STUB_TESTS, ...threadHostileTestFiles(repoRoot), '**/node_modules/**'],
    setupFiles: ['src/__tests__/hermetic-env-setup.ts', 'src/__tests__/process-memo-setup.ts'],
  },
});
