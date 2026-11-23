import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  parseAndroidComponent,
  parseAndroidLaunchablePackages,
  parseAndroidResumedActivity,
  readAndroidBlockingDialogFocus,
} from '../app-parsers.ts';

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
      focusedPackage: 'com.example.app',
    },
  );
});

// Every reader (resumed activity, focused window, foreground) passes its segment here.
test.each([
  [' ActivityRecord{99 u0 com.example.app/.MainActivity t7}', 'com.example.app', '.MainActivity'],
  [
    'Window{84ec7b8 u0 com.android.settings/com.android.settings.Settings$AppNotificationSettingsActivity',
    'com.android.settings',
    'com.android.settings.Settings$AppNotificationSettingsActivity',
  ],
  [
    ' u0 com.example_app2.beta/com.example_app2.Main}',
    'com.example_app2.beta',
    'com.example_app2.Main',
  ],
  [
    ' ActivityRecord{1 u0 com.first.app/.One t1} ActivityRecord{2 u0 com.second.app/.Two t2}',
    'com.first.app',
    '.One',
  ],
])('parseAndroidComponent reads the first package/Activity in %j', (segment, pkg, activity) => {
  assert.deepEqual(parseAndroidComponent(segment), { package: pkg, activity });
});

test.each([
  '',
  'Window{5a1b2c3 u0 NotificationShade}',
  'Window{5a1b2c3 u0 Application Not Responding: com.example.app}',
  ' u0 android/com.android.internal.app.ResolverActivity}',
  ' u0 com.example.app}',
])('parseAndroidComponent names no component in %j', (segment) => {
  assert.equal(parseAndroidComponent(segment), null);
});

test('parseAndroidResumedActivity reads every resumed-marker shape', () => {
  assert.deepEqual(
    parseAndroidResumedActivity(
      '  mResumedActivity: ActivityRecord{99 u0 com.example.app/.MainActivity t7}\n',
    ),
    { package: 'com.example.app', activity: '.MainActivity' },
  );
  assert.deepEqual(
    parseAndroidResumedActivity(
      '  ResumedActivity: ActivityRecord{99 u0 com.example.app/.MainActivity t7}\n',
    ),
    { package: 'com.example.app', activity: '.MainActivity' },
  );
  assert.deepEqual(
    parseAndroidResumedActivity(
      '  topResumedActivity=ActivityRecord{99 u0 com.example.app/.MainActivity t7}\n',
    ),
    { package: 'com.example.app', activity: '.MainActivity' },
  );
});

test('parseAndroidResumedActivity ignores a stale last-resumed record', () => {
  // `mLastResumedActivity:` contains `ResumedActivity:` as a substring. Matching it would let a
  // stale record refuse a kill whose current resumed field is null or names another app.
  assert.equal(
    parseAndroidResumedActivity(
      '  mLastResumedActivity: ActivityRecord{98 u0 com.example.app/.MainActivity t7}\n',
    ),
    null,
  );
});
