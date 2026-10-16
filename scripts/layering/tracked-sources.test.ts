// The one production-versus-test predicate. R11's test-only import ban, R13 and the layering
// scans all call `isProductionSourceFile`, so what counts as production is pinned here once.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProductionSourceFile } from './tracked-sources.ts';

test('production source is a non-test TypeScript file under root src/ or a package src/', () => {
  for (const file of [
    'src/commands/inventory.ts',
    'src/cli.ts',
    'packages/kernel/src/errors.ts',
    'packages/daemon/src/sessions/session-store.ts',
    'packages/replay-port/src/daemon-port/test-command.ts',
    'packages/capture-kit/src/ios-snapshot-engine/conformance-harness.ts',
    'packages/platform-android/src/testing-hooks-policy.ts',
  ]) {
    assert.equal(isProductionSourceFile(file), true, file);
  }
});

test('test support is not production source, whatever shape it takes', () => {
  for (const [file, shape] of [
    ['src/daemon/__tests__/consumer.ts', 'a root __tests__ tree'],
    ['packages/daemon/src/handlers/__tests__/thing.ts', 'a package __tests__ tree'],
    ['__tests__/root-consumer.ts', 'a top-level __tests__ tree'],
    ['src/commands/thing.test.ts', 'a .test file'],
    ['src/commands/thing.spec.ts', 'a .spec file'],
    ['packages/kernel/src/thing.test.ts', 'a package .test file'],
    ['packages/kernel/src/thing.fixtures.ts', 'a .fixtures file'],
    ['packages/kernel/src/thing.fixture.ts', 'a .fixture file'],
    ['packages/platform-android/src/recording/fixtures.ts', 'a fixtures.ts file'],
    ['packages/kernel/src/thing-fixtures.ts', 'a -fixtures file'],
    ['packages/kernel/src/test/harness.ts', 'a package-local test/ tree under src'],
    ['packages/daemon-side/test/harness.ts', 'a package-local test/ tree'],
    ['test/integration/consumer.ts', 'the root test/ tree'],
    ['packages/test-kit/src/loopback.ts', 'the test-kit package'],
  ] as const) {
    assert.equal(isProductionSourceFile(file), false, `${file} (${shape})`);
  }
});

test('tooling and non-TypeScript files are not production sources', () => {
  for (const file of [
    'scripts/vitest-apple-runner-host-setup.ts',
    'scripts/fuzz/arbitraries.ts',
    'src/commands/data.json',
    'packages/kernel/src/errors.js',
    'packages/kernel/package.json',
    'docs/writing/tests.ts',
  ]) {
    assert.equal(isProductionSourceFile(file), false, file);
  }
});
