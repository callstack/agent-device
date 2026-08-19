import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  androidPriorGrantState,
  parseAndroidRuntimePermissionGrants,
} from '../permission-grant-state.ts';

// Captured from `adb shell dumpsys package com.callstack.agentdevicelab` on a Pixel 7 / API 36
// emulator, trimmed to the sections that decide the answer. The indentation is load-bearing:
// `install permissions:` and each `User <id>:` sit at the same depth, and the runtime grants
// hang under the user block — which is the only reason the two can be told apart.
const DUMPSYS = [
  'Packages:',
  '  Package [com.example.app] (5f3a1c2):',
  '    userId=10234',
  '    declared permissions:',
  '      com.example.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION: prot=signature',
  '    install permissions:',
  '      android.permission.MODIFY_AUDIO_SETTINGS: granted=true',
  '      android.permission.RECORD_AUDIO: granted=true',
  '    User 0: ceDataInode=1032405 installed=true hidden=false stopped=false',
  '      gids=[3003]',
  '      runtime permissions:',
  '        android.permission.RECORD_AUDIO: granted=false, flags=[ USER_SENSITIVE_WHEN_GRANTED]',
  '        android.permission.CAMERA: granted=true, flags=[ USER_SET]',
  '    User 10: ceDataInode=99 installed=true hidden=false stopped=false',
  '      runtime permissions:',
  '        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SET]',
  '',
  'Queries:',
  '  queryable via interaction:',
  '    User 0:',
  '',
  'Dexopt state:',
  '  [com.example.app]',
  '    path: /data/app/~~abc==/com.example.app-def==',
].join('\n');

test('runtime grants are read from the requested user only', () => {
  const user0 = parseAndroidRuntimePermissionGrants(DUMPSYS, 0);
  assert.equal(androidPriorGrantState(user0, 'android.permission.RECORD_AUDIO'), 'not_granted');
  assert.equal(androidPriorGrantState(user0, 'android.permission.CAMERA'), 'granted');

  // The same permission, granted for another profile: `pm revoke` acts on the acting user, so
  // reporting user 10's grant for a user 0 revoke would claim a kill that never happened.
  const user10 = parseAndroidRuntimePermissionGrants(DUMPSYS, 10);
  assert.equal(androidPriorGrantState(user10, 'android.permission.RECORD_AUDIO'), 'granted');
  assert.equal(androidPriorGrantState(user10, 'android.permission.CAMERA'), 'unknown');
});

test('install permissions never answer for a runtime permission', () => {
  // RECORD_AUDIO appears as `granted=true` in the install-permission section and `granted=false`
  // in user 0's runtime block. A scan that matched `granted=true` anywhere read the wrong one.
  const grants = parseAndroidRuntimePermissionGrants(DUMPSYS, 0);
  assert.equal(androidPriorGrantState(grants, 'android.permission.RECORD_AUDIO'), 'not_granted');
  assert.equal(
    androidPriorGrantState(grants, 'android.permission.MODIFY_AUDIO_SETTINGS'),
    'unknown',
  );
  assert.equal(androidPriorGrantState(grants, 'android.permission.INTERNET'), 'unknown');
});

test('a user with no runtime-permission block is unknown, not empty', () => {
  assert.equal(parseAndroidRuntimePermissionGrants(DUMPSYS, 11), undefined);
  assert.equal(
    androidPriorGrantState(
      parseAndroidRuntimePermissionGrants(DUMPSYS, 11),
      'android.permission.RECORD_AUDIO',
    ),
    'unknown',
  );
});

test('unparseable output is unknown rather than not-granted', () => {
  for (const output of ['', 'Packages:\n  <none>', 'Error: package not found']) {
    assert.equal(parseAndroidRuntimePermissionGrants(output, 0), undefined, output);
  }
});

test('an empty runtime block answers not_granted for everything it could have listed', () => {
  // Distinct from a missing block: the device reported the list and it was empty, so the app
  // holds nothing — a claim the parser is allowed to make.
  const grants = parseAndroidRuntimePermissionGrants(
    [
      'Packages:',
      '  Package [com.example.app] (5f3a1c2):',
      '    User 0: installed=true',
      '      runtime permissions:',
      '    User 10: installed=true',
    ].join('\n'),
    0,
  );
  assert.notEqual(grants, undefined);
  assert.equal(grants?.size, 0);
});

test('a dump without a Packages section is unknown', () => {
  // Every `dumpsys package <pkg>` carries one (it sits after the resolver tables and Key Set
  // Manager). Its absence means the output is not the dump we can read, so the honest answer
  // is unknown — never the not_granted that would claim the app was left alone.
  const grants = parseAndroidRuntimePermissionGrants(
    [
      'Activity Resolver Table:',
      '  Non-Data Actions:',
      '    User 0: installed=true',
      '      runtime permissions:',
      '        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SET]',
    ].join('\n'),
    0,
  );
  assert.equal(grants, undefined);
});

test('sections after Packages: cannot reopen the scan', () => {
  // `Queries:` repeats `User 0:` with no grants, and `Shared users:` repeats runtime grant lines
  // for the shared uid. Merging either would flip RECORD_AUDIO to granted for a user whose own
  // block says otherwise — the same wrong-answer class as reading the install section.
  const grants = parseAndroidRuntimePermissionGrants(
    [
      DUMPSYS,
      'Shared users:',
      '  SharedUser [android.uid.shared] (a1b2):',
      '    User 0: ceDataInode=0 installed=true',
      '      runtime permissions:',
      '        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SET]',
    ].join('\n'),
    0,
  );

  assert.equal(androidPriorGrantState(grants, 'android.permission.RECORD_AUDIO'), 'not_granted');
  assert.equal(androidPriorGrantState(grants, 'android.permission.CAMERA'), 'granted');
});
