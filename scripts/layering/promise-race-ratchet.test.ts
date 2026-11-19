import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPromiseRaceCounts, countPromiseRaces, packageOf } from './promise-race-ratchet.ts';

test('packageOf maps workspace packages and the root src tree', () => {
  assert.equal(packageOf('packages/host-kit/src/internal/retry.ts'), 'packages/host-kit');
  assert.equal(packageOf('packages/daemon/src/server/http/server-shutdown.ts'), 'packages/daemon');
  assert.equal(packageOf('src/cli/process-exit.ts'), 'src');
});

test('countPromiseRaces counts every occurrence, per package, keys sorted', () => {
  const sources = new Map([
    ['packages/daemon/src/a.ts', 'await Promise.race([x, y]);\nawait Promise.race([z, w]);'],
    ['packages/daemon/src/b.ts', 'const r = Promise.race([p, q]);'],
    ['packages/host-kit/src/c.ts', 'no race here'],
    ['src/d.ts', 'Promise.race([a, b]);'],
  ]);
  assert.deepEqual(countPromiseRaces(sources), {
    'packages/daemon': 3,
    src: 1,
  });
  assert.deepEqual(countPromiseRaces(new Map()), {});
});

test('a count at or under the merge-base passes, including a new package at zero', () => {
  const sources = new Map([
    ['packages/daemon/src/a.ts', 'await Promise.race([x, y]);'],
    ['src/d.ts', 'Promise.race([a, b]);'],
  ]);
  assert.deepEqual(
    checkPromiseRaceCounts(sources, { 'packages/daemon': 2, src: 1, 'packages/other': 4 }),
    [],
  );
  assert.deepEqual(checkPromiseRaceCounts(new Map(), {}), []);
});

test('growth in a known package fails at the first carrier file and line', () => {
  const sources = new Map([
    ['packages/daemon/src/a.ts', 'line one\nline two\nawait Promise.race([x, y]);'],
    ['packages/daemon/src/b.ts', 'await Promise.race([p, q]);'],
  ]);
  const violations = checkPromiseRaceCounts(sources, { 'packages/daemon': 1 });
  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.ok(violation);
  assert.equal(violation.rule, 'R87 promise-race-ratchet');
  assert.equal(violation.file, 'packages/daemon/src/a.ts');
  assert.equal(violation.line, 3);
  assert.match(violation.message, /grew to 2 \(baseline 1 at the merge-base\)/);
  assert.match(violation.message, /settleWithin/);
});

test('a package the merge-base did not have may carry no race at all', () => {
  const sources = new Map([['packages/new-pkg/src/a.ts', 'await Promise.race([x, y]);']]);
  const violations = checkPromiseRaceCounts(sources, { 'packages/daemon': 5 });
  assert.equal(violations.length, 1);
  const [violation] = violations;
  assert.ok(violation);
  assert.equal(violation.file, 'packages/new-pkg/src/a.ts');
  assert.match(violation.message, /grew to 1 \(baseline 0 at the merge-base\)/);
});

test('a shrink or a race-free tree passes without editing the reference', () => {
  const sources = new Map([['packages/daemon/src/a.ts', 'await settleWithin(work, ms);']]);
  assert.deepEqual(checkPromiseRaceCounts(sources, { 'packages/daemon': 5 }), []);
});
