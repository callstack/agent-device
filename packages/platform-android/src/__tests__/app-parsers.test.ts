import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseAndroidLaunchablePackages, readAndroidBlockingDialogFocus } from '../app-parsers.ts';

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

test('readAndroidBlockingDialogFocus preserves responding window text without regex backtracking', () => {
  assert.deepEqual(
    readAndroidBlockingDialogFocus(
      'mCurrentFocus=Window{123 u0 com.example.app/com.example.MainActivity Demo is not responding}',
    ),
    {
      focusObserved: true,
      focus: {
        package: 'com.example.app',
        focusedWindow: '123 u0 com.example.app/com.example.MainActivity Demo is not responding',
        raw: 'mCurrentFocus=Window{123 u0 com.example.app/com.example.MainActivity Demo is not responding}',
      },
    },
  );
});
