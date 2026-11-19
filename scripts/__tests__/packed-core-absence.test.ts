import assert from 'node:assert/strict';
import { test } from 'vitest';
import { packedCoreAbsenceFailures, type PackedCoreForbidden } from '../lib/packed-core-absence.ts';

// Self-test entry: the production list in scripts/check-package.ts starts empty so each
// extraction PR adds one line; this entry proves the rule passes an allowed list and fails
// naming the path on a forbidden one.
const SELF_TEST_FORBIDDEN: PackedCoreForbidden = Object.freeze({
  paths: ['dist/src/platform-web.js'],
  moduleMarkers: ['@agent-device/platform-web'],
});

test('an allowed pack list and bundled dist produce no absence failures', () => {
  const failures = packedCoreAbsenceFailures(SELF_TEST_FORBIDDEN, {
    packedPaths: ['package.json', 'dist/src/cli.js', 'dist/src/platform-runtime.js'],
    distFiles: [
      { path: 'dist/src/cli.js', contents: 'import fs from "node:fs";\n' },
      {
        path: 'dist/src/platform-runtime.js',
        contents: 'const registry = createPlatformModuleRegistry([]);\n',
      },
    ],
  });
  assert.deepEqual(failures, []);
});

test('a forbidden packed path fails naming the path', () => {
  const failures = packedCoreAbsenceFailures(SELF_TEST_FORBIDDEN, {
    packedPaths: ['package.json', 'dist/src/platform-web.js'],
    distFiles: [],
  });
  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.ok(failure !== undefined);
  assert.ok(failure.includes('dist/src/platform-web.js'), failure);
});

test('a forbidden module marker in a bundled dist file fails naming that file', () => {
  const failures = packedCoreAbsenceFailures(SELF_TEST_FORBIDDEN, {
    packedPaths: ['dist/src/bundle.js'],
    distFiles: [{ path: 'dist/src/bundle.js', contents: 'import "@agent-device/platform-web";\n' }],
  });
  assert.equal(failures.length, 1);
  const failure = failures[0];
  assert.ok(failure !== undefined);
  assert.ok(failure.includes('dist/src/bundle.js'), failure);
  assert.ok(failure.includes('@agent-device/platform-web'), failure);
});

test('an empty absence list accepts any packed core', () => {
  const failures = packedCoreAbsenceFailures(Object.freeze({ paths: [], moduleMarkers: [] }), {
    packedPaths: ['dist/src/platform-web.js'],
    distFiles: [{ path: 'dist/src/platform-web.js', contents: '@agent-device/platform-web' }],
  });
  assert.deepEqual(failures, []);
});
