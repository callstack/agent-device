// Parse-shape tests, kept to the cases where a mistake would OVER-credit a lane.
//
// Under-credit corrects itself: the real tree is audited on every PR, so a command
// the model fails to read shows up as an unowned check within one run. Over-credit
// is the dangerous direction — it reads as coverage that is not there — so those are
// the shapes pinned here, plus the two real-tree facts the unit vocabulary exists for.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  commandSegments,
  commandUnits,
  loadModel,
  matchesGlob,
  scriptUnits,
  unitCovers,
  verbatimScripts,
} from './model.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const model = loadModel(repoRoot, tracked);

const scriptModel = (scripts: Record<string, string>) => ({
  scripts,
  vitestProjects: ['unit-core', 'subprocess-stub'],
  opaque: {},
});

test('a commented-out command in a run: block credits nothing', () => {
  assert.deepEqual(commandSegments('echo done # && pnpm test:unit'), ['echo done']);
  // A `#` inside quotes is data, not a comment.
  assert.deepEqual(commandSegments('echo "a # b" && pnpm x'), ['echo "a # b"', 'pnpm x']);
});

test('an env prefix does not hide the command behind it', () => {
  assert.deepEqual(
    scriptUnits(
      'build:x',
      scriptModel({ 'build:x': 'AGENT_DEVICE_XCUITEST_PLATFORM=ios sh ./scripts/build.sh' }),
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

test('a command repeating a script body verbatim credits that script', () => {
  const body = model.scripts['check:package'] as string;
  assert.deepEqual(verbatimScripts(body, model.scripts), ['check:package']);
  assert.deepEqual(verbatimScripts('node scripts/something-else.ts', model.scripts), []);
});

test('commandUnits reads a runner invoked directly, so an owned suite is recognised', () => {
  const units = commandUnits(
    'node --experimental-strip-types scripts/node-test-tmpdir.ts --test test/integration/smoke-cli.test.ts',
    model,
  );
  assert.deepEqual(units, ['node-test:test/integration/smoke-cli.test.ts']);
});

test('path filters use GitHub glob semantics', () => {
  assert.equal(matchesGlob('website/**', 'website/docs/docs/commands.md'), true);
  assert.equal(matchesGlob('docs/**', 'website/docs/x.md'), false);
  assert.equal(matchesGlob('*.md', 'README.md'), true);
  assert.equal(matchesGlob('*.md', 'docs/README.md'), false, '* must not span a separator');
});

test('lanes carry the workflow spelling the catalog used, and only real triggers qualify', () => {
  const labels = model.lanes.map((lane) => lane.label);
  assert.ok(labels.includes('Coverage'), 'CI jobs are named bare');
  assert.ok(labels.includes('iOS / Smoke Tests'), 'other workflows are prefixed');
  const deploy = model.lanes.find((lane) => lane.workflow === 'deploy.yml');
  assert.equal(deploy?.qualifying, false, 'a push-only lane gates nothing on the way in');
});

test('a gate invoked from inside a composite action belongs to the calling lane', () => {
  const android = model.lanes.find((lane) => lane.label === 'Android / Smoke Tests');
  assert.ok(
    android?.gates.includes('android-helpers'),
    'the helper build is reached through the setup action',
  );
});
