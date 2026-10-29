// The related run of `check:affected --run` leaves UNIT_TEST_PROJECTS to the unit suite. That is
// sound only while `test:unit` runs every test of exactly those projects, so drift fails here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { UNIT_TEST_PROJECTS } from './vitest-projects.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const scripts = (
  JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

test('test:unit runs every test of exactly UNIT_TEST_PROJECTS', () => {
  const [runner, mode, ...flags] = (scripts['test:unit'] ?? '').trim().split(/\s+/);
  assert.deepEqual([runner, mode], ['vitest', 'run']);
  const projects: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i] ?? '';
    if (flag === '--project') projects.push(flags[++i] ?? '');
    else if (flag.startsWith('--project=')) projects.push(flag.slice('--project='.length));
    else assert.fail(`test:unit must not filter its projects, found "${flag}"`);
  }
  assert.deepEqual(projects.toSorted(), [...UNIT_TEST_PROJECTS].toSorted());
});

test('the unit check runs test:unit', () => {
  const steps = (scripts['check:unit'] ?? '').split('&&').map((step) => step.trim());
  assert.ok(steps.includes('pnpm test:unit'), `check:unit is "${scripts['check:unit']}"`);
});

test('every UNIT_TEST_PROJECTS entry is a project of vitest.config.ts', async () => {
  const { default: config } = (await import('../../vitest.config.ts')) as {
    default: { test: { projects: { test: { name: string } }[] } };
  };
  const names = config.test.projects.map((project) => project.test.name);
  for (const name of UNIT_TEST_PROJECTS) assert.ok(names.includes(name), `${name} in ${names}`);
});
