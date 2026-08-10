// The Vitest project universe, read as structure.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { vitestProjectNames } from './vitest-projects.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test("the repo's own vitest.config.ts yields exactly its declared projects", () => {
  const source = fs.readFileSync(path.join(repoRoot, 'vitest.config.ts'), 'utf8');
  assert.deepEqual(vitestProjectNames('vitest.config.ts', source), [
    'interaction-contract',
    'output-economy',
    'provider-integration',
    'subprocess-stub',
    'unit-core',
  ]);
});

test('a config the parser cannot find projects in throws rather than reporting none', () => {
  // Returning [] here would mean "no projects to own", i.e. the gate quietly passing — the
  // exact failure mode this whole module exists to prevent.
  assert.throws(
    () => vitestProjectNames('vitest.config.ts', 'export default { test: { name: "solo" } };'),
    /Could not find a `projects: \[\.\.\.\]` array/,
  );
});

test('only names inside the projects array count as projects', () => {
  const config = `export default defineConfig({
    test: {
      name: 'not-a-project',
      projects: [{ test: { name: 'unit-core' } }, { test: { name: 'e2e' } }],
      coverage: { name: 'also-not-a-project' },
    },
  });`;
  assert.deepEqual(vitestProjectNames('vitest.config.ts', config), ['e2e', 'unit-core']);
});
