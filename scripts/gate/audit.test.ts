// Structural ownership regressions: only the canonical action can declare a gate.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { audit, formatFailures } from './audit.ts';
import { loadModel, type Model } from './model.ts';
import { loadLanes } from './workflows.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const base = loadModel(repoRoot, tracked);

function plant(yaml: string): Model {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-lane-'));
  try {
    fs.writeFileSync(path.join(dir, 'planted.yml'), yaml);
    return { ...base, lanes: [...base.lanes, ...loadLanes(dir, repoRoot, base.scripts)] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const workflow = (step: string) => `name: Planted
on:
  pull_request:
jobs:
  planted:
    steps:
${step}`;

test('the live tree is green', () => {
  assert.deepEqual(audit(base), []);
});

test('a structural gate id must exist in CHECK_CATALOG', () => {
  const model = plant(
    workflow(`      - uses: ./.github/actions/run-gate
        with:
          gate: not-a-real-check`),
  );
  assert.ok(audit(model).some((failure) => /names no registered check/.test(failure.message)));
});

test('raw shell text cannot declare ownership', () => {
  const model = plant(
    workflow(`      - run: |
          pnpm gate not-a-real-check
          echo "pnpm gate layering"`),
  );
  assert.ok(!audit(model).some((failure) => /not-a-real-check/.test(failure.message)));
});

test('reusable workflows fail closed because their action declarations are hidden', () => {
  const model = plant(`name: Planted
on:
  pull_request:
jobs:
  planted:
    uses: ./.github/workflows/reusable.yml`);
  assert.ok(
    audit(model).some((failure) => /runs steps this loader never opens/.test(failure.message)),
  );
});

test('unknown assertion kinds remain visible in the report', () => {
  const report = formatFailures([
    { assertion: 'owned', message: 'a' },
    { assertion: 'new-kind', message: 'b' },
  ]);
  assert.match(report, /Registered checks no lane declares:/);
  assert.match(report, /Other failures \(new-kind\):/);
  assert.match(report, /2 failure\(s\)/);
});
