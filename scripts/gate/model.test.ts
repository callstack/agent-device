// Unit-resolution tests, kept to the cases where a mistake would OVER-credit a lane.
//
// Under-credit corrects itself: the real tree is audited on every PR, so a command
// the model fails to read shows up as an unowned check within one run. Over-credit
// is the dangerous direction — it reads as coverage that is not there — so those are
// the shapes pinned here, plus the two real-tree facts the unit vocabulary exists for.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { loadModel, scriptUnits, unitCovers } from './model.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);
const model = loadModel(repoRoot, tracked);

const scriptModel = (scripts: Record<string, string>) => ({
  scripts,
  vitestProjects: ['unit-core', 'subprocess-stub'],
  opaque: {},
});

test('an env prefix does not hide the command behind it', () => {
  assert.deepEqual(
    scriptUnits(
      'build:x',
      scriptModel({
        'build:x': 'AGENT_DEVICE_XCUITEST_PLATFORM=ios sh ./scripts/build.sh',
      }),
    ),
    ['script:build:x'],
  );
});

test('a filtered Vitest run does not credit the whole project', () => {
  const units = scriptUnits(
    'docs',
    scriptModel({
      docs: 'vitest run --project unit-core src/__tests__/command-doc-coverage.test.ts',
    }),
  );
  assert.deepEqual(units, ['vitest:unit-core@src/__tests__/command-doc-coverage.test.ts']);
  assert.equal(
    unitCovers('vitest:unit-core', units[0] as string),
    true,
    'the whole project covers the file',
  );
  assert.equal(
    unitCovers(units[0] as string, 'vitest:unit-core'),
    false,
    'the file does not cover the project',
  );
});

test('a bare Vitest run spans every configured project', () => {
  assert.deepEqual(scriptUnits('all', scriptModel({ all: 'vitest run --coverage' })), [
    'vitest:unit-core',
    'vitest:subprocess-stub',
  ]);
});

test('a negated --project subtracts from the configured set, so the skipped one is not credited', () => {
  assert.deepEqual(
    scriptUnits('cov', scriptModel({ cov: 'vitest run --coverage --project=!subprocess-stub' })),
    ['vitest:unit-core'],
  );
});

// The real `test:coverage:ci` shape: the second leg is a nested script whose body carries an env
// prefix (it blanks the coverage-shard switches). Both indirections have to survive, or the lane
// stops owning the project it hands to that leg.
test('the two halves of test:coverage:ci together still own every project', () => {
  assert.deepEqual(
    scriptUnits(
      'test:coverage:ci',
      scriptModel({
        'test:coverage:ci':
          'vitest run --coverage --project=!subprocess-stub && pnpm test:subprocess-stub',
        'test:subprocess-stub':
          'AGENT_DEVICE_COVERAGE_SHARD= AGENT_DEVICE_COVERAGE_MERGE= vitest run --project subprocess-stub',
      }),
    ),
    ['vitest:unit-core', 'vitest:subprocess-stub'],
  );
});

test('aggregates expand transitively, so a lane running the aggregate owns its parts', () => {
  const units = scriptUnits(
    'check:all',
    scriptModel({
      'check:all': 'pnpm lint && pnpm test:unit',
      lint: 'oxlint .',
      'test:unit': 'vitest run --project unit-core',
    }),
  );
  assert.deepEqual(units, ['script:lint', 'vitest:unit-core']);
});

test('`node --test` globs expand against the tree, which is how test:smoke is owned', () => {
  const smoke = scriptUnits('test:smoke', model);
  const integration = scriptUnits('test:integration:node', model);
  assert.ok(smoke.length > 1, 'the smoke glob must resolve to real files');
  for (const unit of smoke) {
    assert.ok(integration.includes(unit), `${unit} must be covered by the integration glob`);
  }
});
