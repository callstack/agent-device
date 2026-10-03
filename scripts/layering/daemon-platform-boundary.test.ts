import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DAEMON_PLATFORM_BOUNDARY_RULE,
  daemonPlatformBoundaryViolations,
  findDaemonPlatformDependencies,
} from './daemon-platform-boundary.ts';

const daemonFile = 'src/daemon/terminal-boundary-fixture.ts';

function dependencies(source: string, file = daemonFile) {
  return findDaemonPlatformDependencies([{ path: file, source }]);
}

function violations(source: string, file = daemonFile) {
  return daemonPlatformBoundaryViolations([{ path: file, source }]);
}

test('R65 rejects static, type-only, dynamic, type, and re-export dependencies with source lines', () => {
  const source = [
    "import { old } from '../platforms/android/old.ts';",
    "import type { OldType } from '../platforms/android/types.ts';",
    "const lazy = import('../platforms/android/lazy.ts');",
    "type ImportedType = import('../platforms/android/type.ts').ImportedType;",
    "export { old } from '../platforms/android/re-export.ts';",
    "export type { OldType } from '@agent-device/platform-android/types';",
    "export * from '@agent-device/platform-apple';",
  ].join('\n');

  assert.deepEqual(
    dependencies(source).map(({ kind, spec, line, target }) => ({ kind, spec, line, target })),
    [
      {
        kind: 'static import',
        spec: '../platforms/android/old.ts',
        line: 1,
        target: 'src/platforms/android/old.ts',
      },
      {
        kind: 'type-only import',
        spec: '../platforms/android/types.ts',
        line: 2,
        target: 'src/platforms/android/types.ts',
      },
      {
        kind: 'dynamic import',
        spec: '../platforms/android/lazy.ts',
        line: 3,
        target: 'src/platforms/android/lazy.ts',
      },
      {
        kind: 'type import',
        spec: '../platforms/android/type.ts',
        line: 4,
        target: 'src/platforms/android/type.ts',
      },
      {
        kind: 're-export',
        spec: '../platforms/android/re-export.ts',
        line: 5,
        target: 'src/platforms/android/re-export.ts',
      },
      {
        kind: 'type-only re-export',
        spec: '@agent-device/platform-android/types',
        line: 6,
        target: '@agent-device/platform-android/types',
      },
      {
        kind: 're-export',
        spec: '@agent-device/platform-apple',
        line: 7,
        target: '@agent-device/platform-apple',
      },
    ],
  );

  assert.deepEqual(
    violations(source).map(({ rule, file, line }) => ({ rule, file, line })),
    Array.from({ length: 7 }, (_, index) => ({
      rule: DAEMON_PLATFORM_BOUNDARY_RULE,
      file: daemonFile,
      line: index + 1,
    })),
  );
});

test('R65 recognizes side-effect and aliased imports, including nested daemon paths', () => {
  const source = [
    "import '../../platforms/web/runtime.ts';",
    "import { runtime as platformRuntime } from '@agent-device/platform-web/runtime';",
  ].join('\n');

  assert.deepEqual(
    dependencies(source, 'src/daemon/handlers/terminal-boundary-fixture.ts').map((found) => ({
      kind: found.kind,
      line: found.line,
      spec: found.spec,
      target: found.target,
    })),
    [
      {
        kind: 'static import',
        line: 1,
        spec: '../../platforms/web/runtime.ts',
        target: 'src/platforms/web/runtime.ts',
      },
      {
        kind: 'static import',
        line: 2,
        spec: '@agent-device/platform-web/runtime',
        target: '@agent-device/platform-web/runtime',
      },
    ],
  );
});

test('R65 ignores comments, ordinary strings, unresolved dynamic imports, and lookalike names', () => {
  const source = [
    'const documentation = "import(\'../platforms/android/comment.ts\'); @agent-device/platform-android";',
    "// import { ignored } from '../platforms/android/comment.ts';",
    "const packageName = '@agent-device/platform-android';",
    "const relativeName = '../platforms/android/not-an-import.ts';",
    'const computed = import(platformSpecifier);',
    "import '../platforms-sibling/not-platform.ts';",
    "import '@agent-device/platforms';",
    "import '@agent-device/platform';",
  ].join('\n');

  assert.deepEqual(dependencies(source), []);
});

test('R65 rejects require, import-equals, and template-literal type imports', () => {
  const source = [
    "const android = require('@agent-device/platform-android');",
    'const runtime = require(`../platforms/android/runtime.ts`);',
    "import web = require('@agent-device/platform-web');",
    'type Apple = import(`@agent-device/platform-apple`).Apple;',
    'type Android = import(`../platforms/android/types.ts`).Android;',
  ].join('\n');

  assert.deepEqual(
    dependencies(source).map(({ kind, spec, line }) => ({ kind, spec, line })),
    [
      { kind: 'require', spec: '@agent-device/platform-android', line: 1 },
      { kind: 'require', spec: '../platforms/android/runtime.ts', line: 2 },
      { kind: 'import equals', spec: '@agent-device/platform-web', line: 3 },
      { kind: 'type import', spec: '@agent-device/platform-apple', line: 4 },
      { kind: 'type import', spec: '../platforms/android/types.ts', line: 5 },
    ],
  );
});

test('R65 folds statically constructed dynamic platform specifiers', () => {
  const source = [
    "const apple = import('@agent-device/' + 'platform-apple');",
    'const android = import(`../platforms/${"android"}/runtime.ts`);',
    "const wrapped = import((('@agent-device/' + 'platform-android')));",
    'const required = require((`@agent-device/platform-web`));',
  ].join('\n');

  assert.deepEqual(
    dependencies(source).map(({ kind, spec, line }) => ({ kind, spec, line })),
    [
      { kind: 'dynamic import', spec: '@agent-device/platform-apple', line: 1 },
      { kind: 'dynamic import', spec: '../platforms/android/runtime.ts', line: 2 },
      { kind: 'dynamic import', spec: '@agent-device/platform-android', line: 3 },
      { kind: 'require', spec: '@agent-device/platform-web', line: 4 },
    ],
  );
});

test('R65 unwraps erased TypeScript expressions around executable specifiers', () => {
  const source = [
    "void import('@agent-device/platform-android' as string);",
    "require('@agent-device/platform-web' satisfies string);",
    "void import(<string>'../platforms/apple/runtime.ts');",
  ].join('\n');

  assert.deepEqual(
    dependencies(source).map(({ kind, spec, line }) => ({ kind, spec, line })),
    [
      { kind: 'dynamic import', spec: '@agent-device/platform-android', line: 1 },
      { kind: 'require', spec: '@agent-device/platform-web', line: 2 },
      { kind: 'dynamic import', spec: '../platforms/apple/runtime.ts', line: 3 },
    ],
  );
});

test('R65 follows common createRequire and require aliases', () => {
  const source = [
    "import { createRequire as makeRequire } from 'node:module';",
    "import * as moduleApi from 'node:module';",
    "import moduleDefault from 'node:module';",
    'const load = makeRequire(import.meta.url);',
    'const loadAgain = load;',
    "loadAgain('@agent-device/platform-android');",
    "makeRequire(import.meta.url)('../platforms/web/runtime.ts');",
    "moduleApi.createRequire(import.meta.url)('@agent-device/platform-apple');",
    "moduleDefault.createRequire(import.meta.url)('@agent-device/platform-web');",
    'const loadAlias = require;',
    "loadAlias('@agent-device/platform-linux');",
    "module.require('@agent-device/platform-vega');",
    "const { createRequire: fromCjs } = require('node:module');",
    "fromCjs(import.meta.url)('@agent-device/platform-harmonyos');",
  ].join('\n');

  assert.deepEqual(
    dependencies(source).map(({ spec, line }) => ({ spec, line })),
    [
      { spec: '@agent-device/platform-android', line: 6 },
      { spec: '../platforms/web/runtime.ts', line: 7 },
      { spec: '@agent-device/platform-apple', line: 8 },
      { spec: '@agent-device/platform-web', line: 9 },
      { spec: '@agent-device/platform-linux', line: 11 },
      { spec: '@agent-device/platform-vega', line: 12 },
      { spec: '@agent-device/platform-harmonyos', line: 14 },
    ],
  );
});

test('R65 rejects triple-slash concrete-platform type references', () => {
  const source = [
    '/// <reference types="@agent-device/platform-android" />',
    '/// <reference path = "../platforms/apple/types.ts" />',
    '/*',
    '/// <reference types="@agent-device/platform-web" />',
    '*/',
    'export {};',
  ].join('\n');
  assert.deepEqual(
    dependencies(source).map(({ kind, spec, line }) => ({ kind, spec, line })),
    [
      { kind: 'type import', spec: '@agent-device/platform-android', line: 1 },
      { kind: 'type import', spec: '../platforms/apple/types.ts', line: 2 },
    ],
  );
});

test('R65 rejects platform selection inside cleanup orchestrators', () => {
  const direct = violations(
    "export const cleanup = (session: any) => session.device.platform === 'android';",
    'src/daemon/session-teardown.ts',
  );
  assert.match(direct[0]?.message ?? '', /may not select a concrete platform/);

  const predicate = violations(
    'export const cleanup = (device: any) => isIosFamily(device);',
    'src/daemon/snapshot-session.ts',
  );
  assert.match(predicate[0]?.message ?? '', /typed root-composed cleanup capability/);

  const destructured = violations(
    "export const cleanup = (session: any) => { const { platform } = session.device; return platform === 'android'; };",
    'src/daemon/session-lifecycle/internal/session-close-lifecycle-teardown.ts',
  );
  assert.match(destructured[0]?.message ?? '', /may not select a concrete platform/);

  assert.deepEqual(
    violations(
      'export const cleanup = (owner: any, device: any) => owner.cleanupSessionlessExecutionHost(device);',
      'src/daemon/snapshot-session.ts',
    ),
    [],
  );
});

test('R65 ignores non-daemon and test-shaped records even when their syntax is red', () => {
  const source = "import { platform } from '../platforms/android/runtime.ts';";
  assert.deepEqual(dependencies(source, 'src/core/terminal-boundary-fixture.ts'), []);
  assert.deepEqual(dependencies(source, 'src/daemon/terminal-boundary-fixture.test.ts'), []);
  assert.deepEqual(dependencies(source, 'src/daemon/__tests__/terminal-boundary-fixture.ts'), []);
});

test('R65 treats a relative specifier as legacy platform code only after path resolution', () => {
  const source = [
    "import { platform } from '../../platforms/android/runtime.ts';",
    "import { sibling } from '../platforms-sibling/runtime.ts';",
    "import { exact } from '../platforms';",
  ].join('\n');

  assert.deepEqual(
    dependencies(source).map(({ spec, target, line }) => ({ spec, target, line })),
    [
      {
        spec: '../platforms',
        target: 'src/platforms',
        line: 3,
      },
    ],
  );
});
