import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  classifyAndroidAppTarget,
  formatAndroidInstalledPackageRequiredMessage,
} from '../open-target.ts';

test('classifyAndroidAppTarget distinguishes package, binary, and other targets', () => {
  const cases: Array<{ target: string; expected: 'package' | 'binary' | 'other' }> = [
    { target: 'com.example.app', expected: 'package' },
    { target: 'com.example.apk', expected: 'package' },
    { target: '/tmp/app-debug.apk', expected: 'binary' },
    { target: './app-debug.apk', expected: 'binary' },
    { target: 'app-debug.apk', expected: 'binary' },
    { target: 'build/app.aab', expected: 'binary' },
    { target: 'settings', expected: 'other' },
    { target: 'SampleApp', expected: 'other' },
  ];

  for (const { target, expected } of cases) {
    assert.equal(classifyAndroidAppTarget(target), expected, target);
  }
});

test('formatAndroidInstalledPackageRequiredMessage echoes the invalid target', () => {
  assert.equal(
    formatAndroidInstalledPackageRequiredMessage('app-debug.apk'),
    'Android runtime hints require an installed package name, not "app-debug.apk". Install or reinstall the app first, then relaunch by package.',
  );
});
