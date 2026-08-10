import assert from 'node:assert/strict';
import { test } from 'vitest';
import { assertAndroidLogPackageSafe } from './package-name.ts';

test('Android app-log package validation preserves the legacy safe grammar', () => {
  assert.doesNotThrow(() => assertAndroidLogPackageSafe('com.example.app:worker'));
  assert.throws(
    () => assertAndroidLogPackageSafe('com.example.app;rm -rf /'),
    /Invalid Android package name for logs/,
  );
});
