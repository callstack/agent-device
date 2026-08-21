import { expect, test } from 'vitest';
import path from 'node:path';
import { eagerClosureOf } from '../../__tests__/eager-import-closure.fixtures.ts';

/**
 * Session teardown runs for every closed session on every platform, so its eager
 * import closure is paid by all of them. The android cleanup helpers
 * (`perf.ts`, `snapshot-helper.ts`) only matter when the corresponding capture
 * actually ran on the session; they load through function-scoped `await import`
 * behind their existing guards (the register-builtins interactor lazy pattern).
 *
 * This pins that seam: restoring either helper to a static import puts it back
 * in the eager closure and fails here.
 */

const srcRoot = path.resolve(import.meta.dirname, '../..');
const teardownFile = path.resolve(srcRoot, 'daemon/session-teardown.ts');
const LAZY_ANDROID_HELPERS = [
  /platforms[/\\]android[/\\]perf\.ts$/,
  /platforms[/\\]android[/\\]snapshot-helper\.ts$/,
];

test('the session teardown eager import closure never evaluates the android cleanup helpers', () => {
  const offenders = eagerClosureOf(teardownFile).filter((file) =>
    LAZY_ANDROID_HELPERS.some((pattern) => pattern.test(file)),
  );

  expect(
    offenders.map((file) => path.relative(srcRoot, file)),
    'Load the android perf/snapshot-helper cleanup helpers on demand instead: teardown is shared ' +
      'by every platform, and eagerly evaluating these drags their whole subtree into sessions ' +
      'that never ran an android capture.',
  ).toEqual([]);
});

test('the teardown closure walk is reachable and the dynamic seam exists', () => {
  // Non-vacuity: a resolver bug that returned an empty closure would make the
  // guard above pass while proving nothing, so pin a real lower bound…
  const closure = eagerClosureOf(teardownFile);
  expect(closure.length).toBeGreaterThan(20);
  expect(closure).toContain(path.resolve(srcRoot, 'daemon/materialized-path-registry.ts'));
});
