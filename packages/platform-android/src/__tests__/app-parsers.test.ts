import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseAndroidLaunchablePackages } from '../app-parsers.ts';

test('parseAndroidLaunchablePackages ignores cmd package query metadata lines', () => {
  assert.deepEqual(
    parseAndroidLaunchablePackages(
      [
        '25',
        'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true',
        'com.google.android.apps.maps/.MainActivity',
        'service-without-component',
        'org.mozilla.firefox/.App',
      ].join('\n'),
    ),
    ['com.google.android.apps.maps', 'org.mozilla.firefox'],
  );
});
