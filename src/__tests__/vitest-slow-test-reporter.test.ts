import { test } from 'vitest';
import assert from 'node:assert/strict';
import { classifySlowTest, reportSlowTests } from '../../scripts/vitest-slow-test-reporter.ts';

const base = {
  root: '/repo',
  moduleId: '/repo/src/utils/__tests__/example.test.ts',
  name: 'does a thing',
  fullName: 'group > does a thing',
};

test('under-budget tests are not offenders', () => {
  assert.equal(classifySlowTest({ ...base, durationMs: 2_000 }), null);
});

test('over-budget unit tests enter the warn band; 2x budget enforces', () => {
  const warn = classifySlowTest({ ...base, durationMs: 3_000 });
  assert.ok(warn);
  assert.equal(warn.enforce, false);
  const fail = classifySlowTest({ ...base, durationMs: 5_100 });
  assert.ok(fail);
  assert.equal(fail.enforce, true);
  assert.equal(fail.key, 'src/utils/__tests__/example.test.ts :: group does a thing');
});

test('integration paths get the larger budget', () => {
  const offender = classifySlowTest({
    ...base,
    moduleId: '/repo/test/integration/provider-scenarios/example.test.ts',
    durationMs: 10_000,
  });
  assert.equal(offender, null);
});

test('known slow tests are reported when they exceed the budget', () => {
  const offender = classifySlowTest({
    root: '/repo',
    moduleId: '/repo/src/platforms/android/__tests__/app-lifecycle-install.test.ts',
    name: 'installAndroidApp installs .apk via adb install -r',
    fullName: 'installAndroidApp installs .apk via adb install -r',
    durationMs: 9_000,
  });
  assert.ok(offender);
  assert.equal(offender.enforce, true);
});

test('reportSlowTests fails only on enforced offenders and prints both bands', () => {
  const messages: string[] = [];
  const warnOnly = reportSlowTests(
    [{ key: 'a', durationMs: 3_000, budgetMs: 2_500, enforce: false }],
    (m) => messages.push(m),
  );
  assert.equal(warnOnly, false);
  assert.match(messages[0] ?? '', /load-variance band/);

  messages.length = 0;
  const failing = reportSlowTests(
    [
      { key: 'a', durationMs: 3_000, budgetMs: 2_500, enforce: false },
      { key: 'b', durationMs: 6_000, budgetMs: 2_500, enforce: true },
    ],
    (m) => messages.push(m),
  );
  assert.equal(failing, true);
  assert.equal(messages.length, 2);
  assert.match(messages[1] ?? '', /must not wait real time/);
});
