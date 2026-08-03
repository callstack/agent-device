import assert from 'node:assert/strict';
import { test } from 'vitest';
import { findPrivateWorkspaceImportLeaks } from '../../scripts/check-bundle-private-imports.ts';

test('finds private workspace package imports left in emitted chunks', () => {
  const leaks = findPrivateWorkspaceImportLeaks([
    {
      file: 'dist/src/sdk-selectors.js',
      content: [
        'import{x}from"@agent-device/ad-script";',
        'const replay=import("@agent-device/ad-replay");',
        'const duplicate=import("@agent-device/ad-script");',
      ].join(''),
    },
    {
      file: 'dist/src/daemon.js',
      content: 'const script=require("@agent-device/ad-script/internal");',
    },
  ]);

  assert.deepEqual(leaks, [
    { file: 'dist/src/sdk-selectors.js', specifier: '@agent-device/ad-script' },
    { file: 'dist/src/sdk-selectors.js', specifier: '@agent-device/ad-replay' },
    { file: 'dist/src/daemon.js', specifier: '@agent-device/ad-script/internal' },
  ]);
});

test('ignores bundled mentions and external runtime dependencies', () => {
  assert.deepEqual(
    findPrivateWorkspaceImportLeaks([
      {
        file: 'dist/src/cli.js',
        content: [
          'const diagnostic="@agent-device/ad-script";',
          'import{stringify}from"yaml";',
          'const scope="@agent-device-example/public";',
        ].join(''),
      },
    ]),
    [],
  );
});
