// End-to-end coverage of the `pnpm repo-health` CLI. It spawns the command as a subprocess (so it
// exercises argument handling and the file it writes over the real tree), which is why this lives
// in the `subprocess-stub` vitest project rather than `unit-core` — see #1412 coordination rule 4.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { RepoHealthSnapshot } from './model.ts';

function runRepoHealth(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/repo-health/run.ts', ...args],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 32 },
  );
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('the default run prints a summary and exits zero over the real tree', () => {
  const { status, stdout } = runRepoHealth([]);
  expect(status, stdout).toBe(0);
  expect(stdout).toContain('Repo health snapshot');
  expect(stdout).toContain('graph reproduces baseline: yes');
  expect(stdout).toContain('observatory only');
});

test('--json emits a schema-versioned snapshot with every metric family', () => {
  const { status, stdout } = runRepoHealth(['--json']);
  expect(status, stdout).toBe(0);

  const snapshot = JSON.parse(stdout) as RepoHealthSnapshot;
  expect(snapshot.schemaVersion).toBe(1);

  // Provenance is mandatory in v1 (issue amendment): schemaVersion, commit, per-analyzer tool
  // hashes, and input provenance must all be present so #1424 can persist history.
  expect(snapshot.provenance.commit).toMatch(/^[0-9a-f]{7,40}$/);
  expect(Object.keys(snapshot.provenance.tool)).toContain('depgraph');
  expect(snapshot.provenance.inputs.sourceFiles).toBeGreaterThan(0);

  // Field names are the #1424 delta contract — pin the ones the comment consumes.
  expect(snapshot.metrics.depgraph.redundantEdges).toBeGreaterThan(0);
  expect(snapshot.metrics.layering.typeInversionTotal).toBeGreaterThanOrEqual(0);
  expect(snapshot.metrics.slowTest.unitBudgetMs).toBeGreaterThan(0);
  expect(snapshot.metrics.fallow.suppressions.total).toBeGreaterThanOrEqual(0);
  expect(snapshot.metrics.bench.cases).toBeGreaterThan(0);
  expect(snapshot.metrics.skillgym.cases).toBeGreaterThan(0);

  // The consistency assertion must pass on a clean tree.
  expect(snapshot.consistency.r6.ok).toBe(true);

  // The main-sequence spot-check the acceptance names.
  const concrete = snapshot.metrics.mainSequence.concreteHighFanIn.map((module) => module.file);
  expect(concrete).toContain('utils/exec.ts');
  expect(concrete).toContain('daemon/ref-frame.ts');
});

test('--out writes the same JSON snapshot to a file', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'repo-health-')), 'snapshot.json');
  const { status } = runRepoHealth(['--out', out]);
  expect(status).toBe(0);
  const written = JSON.parse(readFileSync(out, 'utf8')) as RepoHealthSnapshot;
  expect(written.schemaVersion).toBe(1);
  expect(written.consistency.r6.ok).toBe(true);
});
