// Resolving a command to the work it performs — see test-context.ts for why these are synthetic.

import assert from 'node:assert/strict';
import test from 'node:test';
import { packageScriptSuite } from './suite-ownership.ts';
import { context, lanesFor } from './test-context.ts';

test('a job owns the work at the far end of an aggregate script chain', () => {
  // `pnpm check:all` names neither the layering guard nor the suite; the graph has to walk two
  // hops to find them. "Does the workflow text mention check:layering?" would answer no.
  const ctx = context({
    packageScripts: new Map([
      ['check:all', 'pnpm check:layering && pnpm test:unit'],
      ['check:layering', 'node scripts/layering/check.ts'],
      ['test:unit', 'vitest run --project unit-core'],
    ]),
  });
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  gate:\n    steps:\n      - run: pnpm check:all\n' },
    ctx,
  );
  assert.deepEqual([...lane!.terminals].sort(), [
    'exec:scripts/layering/check.ts',
    'vitest:unit-core',
  ]);
});

test('renaming an intermediate script breaks the chain instead of leaving a false claim', () => {
  // The workflow still says `pnpm check:all`, and `check:all` still says `pnpm check:layering`.
  // Only the leaf was renamed. A name-presence check stays green here; this must not.
  const ctx = context({
    packageScripts: new Map([
      ['check:all', 'pnpm check:layering && pnpm test:unit'],
      ['check:layering:renamed', 'node scripts/layering/check.ts'],
      ['test:unit', 'vitest run --project unit-core'],
    ]),
  });
  const [lane] = lanesFor(
    { 'ci.yml': 'jobs:\n  gate:\n    steps:\n      - run: pnpm check:all\n' },
    ctx,
  );
  assert.deepEqual(
    lane!.unresolved.map(({ kind, source }) => `${source} ${kind}`),
    ['ci.yml#gate missing-script'],
  );
  assert.ok(
    lane!.unresolved[0]!.detail.includes('pnpm check:layering'),
    'the failure must name the script that stopped existing',
  );
  assert.ok(!lane!.terminals.has('exec:scripts/layering/check.ts'));
});

test('an alias cycle stops re-expanding instead of recursing forever', () => {
  const ctx = context({
    packageScripts: new Map([
      ['a', 'pnpm b && node scripts/a.ts'],
      ['b', 'pnpm a && node scripts/b.ts'],
    ]),
  });
  const suite = packageScriptSuite('a', ctx.packageScripts.get('a')!, ctx);
  assert.deepEqual([...suite.terminals].sort(), ['exec:scripts/a.ts', 'exec:scripts/b.ts']);
});

test('a dynamic command position is reported with its workflow, job, and step', () => {
  const [lane] = lanesFor(
    {
      'ci.yml':
        'jobs:\n  matrix:\n    steps:\n      - name: Run the matrix command\n' +
        '        run: ${{ matrix.command }}\n',
    },
    context(),
  );
  assert.deepEqual(
    lane!.unresolved.map(({ source, step, kind }) => ({ source, step, kind })),
    [{ source: 'ci.yml#matrix', step: 'Run the matrix command', kind: 'dynamic-command' }],
  );
});

test('a script that resolves to no unit of work at all is reported, not silently owned', () => {
  const ctx = context({ packageScripts: new Map([['check:nothing', 'echo hello']]) });
  const suite = packageScriptSuite('check:nothing', 'echo hello', ctx);
  assert.deepEqual(
    suite.unresolved.map(({ kind }) => kind),
    ['no-terminal'],
  );
});

test('an unfiltered vitest run owns every project; a filtered one owns only what it names', () => {
  const ctx = context({ vitestProjects: ['unit-core', 'subprocess-stub', 'output-economy'] });
  const lanes = lanesFor(
    {
      'ci.yml':
        'jobs:\n  all:\n    steps:\n      - run: pnpm exec vitest run --coverage\n' +
        '  some:\n    steps:\n      - run: pnpm exec vitest run --project unit-core\n',
    },
    ctx,
  );
  assert.deepEqual([...lanes[0]!.terminals].sort(), [
    'vitest:output-economy',
    'vitest:subprocess-stub',
    'vitest:unit-core',
  ]);
  assert.deepEqual([...lanes[1]!.terminals], ['vitest:unit-core']);
});

test('a transparent wrapper resolves to the test files it forwards, not to itself', () => {
  const ctx = context({
    transparentWrappers: new Set(['scripts/node-test-tmpdir.ts']),
    packageScripts: new Map([
      ['test:x', 'node scripts/node-test-tmpdir.ts --test test/a.test.ts test/b.test.ts'],
    ]),
  });
  const suite = packageScriptSuite('test:x', ctx.packageScripts.get('test:x')!, ctx);
  assert.deepEqual([...suite.terminals].sort(), [
    'node-test:test/a.test.ts',
    'node-test:test/b.test.ts',
  ]);
});

test('an opaque runner reaches only what its declared edge says it reaches', () => {
  const ctx = context({
    vitestProjects: ['unit-core', 'subprocess-stub'],
    declaredTerminals: new Map([['scripts/run.ts', ['vitest:unit-core']]]),
    packageScripts: new Map([['test:ci', 'node scripts/run.ts --coverage']]),
  });
  const suite = packageScriptSuite('test:ci', ctx.packageScripts.get('test:ci')!, ctx);
  assert.deepEqual([...suite.terminals].sort(), ['exec:scripts/run.ts', 'vitest:unit-core']);
  assert.ok(!suite.terminals.has('vitest:subprocess-stub'), 'a declared edge must not over-claim');
});

test('flags are dropped from a terminal but positional arguments are not', () => {
  // `test:replay:ios` and `test:replay:macos` both run src/bin.ts; only the positional corpus
  // path tells them apart, and a CI-only `--retries 2` must not split the terminal.
  const ctx = context({
    packageScripts: new Map([
      ['test:replay:ios', 'node src/bin.ts test test/replays/ios'],
      ['test:replay:macos', 'node src/bin.ts test test/replays/macos'],
    ]),
  });
  const ios = packageScriptSuite(
    'test:replay:ios',
    ctx.packageScripts.get('test:replay:ios')!,
    ctx,
  );
  const macos = packageScriptSuite(
    'test:replay:macos',
    ctx.packageScripts.get('test:replay:macos')!,
    ctx,
  );
  assert.deepEqual([...ios.terminals], ['exec:src/bin.ts test test/replays/ios']);
  assert.notDeepEqual([...ios.terminals], [...macos.terminals]);

  const [lane] = lanesFor(
    { 'macos.yml': 'jobs:\n  m:\n    steps:\n      - run: pnpm test:replay:macos --retries 2\n' },
    ctx,
  );
  assert.deepEqual([...lane!.terminals], [...macos.terminals]);
});
