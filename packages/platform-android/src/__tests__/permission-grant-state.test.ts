import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseAndroidRuntimePermissionGrants } from '../permission-grant-state.ts';

// Captured from `adb shell dumpsys package com.callstack.agentdevicelab` on a Pixel 7 / API 36
// emulator, trimmed to the sections that decide the answer. The indentation is load-bearing:
// `install permissions:` and each `User <id>:` sit at the same depth, and the runtime grants
// hang under the user block — which is the only reason the two can be told apart.
const DUMPSYS = [
  'Packages:',
  '  Package [com.example.app] (5f3a1c2):',
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

// `undefined` is the answer for anything the dump does not place inside the requested user's
// runtime block: an install-permission grant (`pm revoke` cannot touch it), another profile's
// grant, or a permission that user never declared. The caller reports that as `unknown`.
test.each([
  [0, 'android.permission.RECORD_AUDIO', 'not_granted', 'acting user overrides the install grant'],
  [0, 'android.permission.CAMERA', 'granted', 'acting user'],
  [10, 'android.permission.RECORD_AUDIO', 'granted', 'other profile, only when asked for'],
  [10, 'android.permission.CAMERA', undefined, 'absent for that user'],
  [0, 'android.permission.MODIFY_AUDIO_SETTINGS', undefined, 'install-only'],
  [0, 'android.permission.INTERNET', undefined, 'never mentioned'],
] as const)('user %s reads %s as %s (%s)', (userId, permission, expected, _why) => {
  assert.equal(parseAndroidRuntimePermissionGrants(DUMPSYS, userId)?.get(permission), expected);
});

// A missing block is not an empty one. Every input here means "the device did not tell us",
// which must stay distinguishable from "the app holds nothing".
test.each([
  ['no runtime block for that user', DUMPSYS, 11],
  ['empty output', '', 0],
  ['no Packages section', 'Activity Resolver Table:\n  User 0:\n    runtime permissions:', 0],
  ['a package section without the user', 'Packages:\n  Package [com.example.app] (abc):', 0],
] as const)('%s reads as unknown', (_label, output, userId) => {
  assert.equal(parseAndroidRuntimePermissionGrants(output, userId), undefined);
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

  assert.equal(grants?.get('android.permission.RECORD_AUDIO'), 'not_granted');
  assert.equal(grants?.get('android.permission.CAMERA'), 'granted');
});
