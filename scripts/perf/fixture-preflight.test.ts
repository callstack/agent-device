import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { test } from 'vitest';
import {
  androidReleaseFixtureProblem,
  parseAndroidPackageFacts,
  resolveAdb,
} from './fixture-preflight.mjs';

// Trimmed from `adb shell dumpsys package com.callstack.agentdevicelab` on an emulator that had
// the dev-client build installed: the flag lists and the dev-launcher activity are the real layout.
const DEV_CLIENT_DUMP = `
  /data/app/~~abc==/com.callstack.agentdevicelab-XYZ==/base.apk
      expo-dev-launcher:
        c4f9b9f com.callstack.agentdevicelab/expo.modules.devlauncher.compose.AuthActivity filter b49e4ec
          Scheme: "expo-dev-launcher"
    versionName=1.0.0
    flags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP KILL_AFTER_RESTORE ]
    privateFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE_VIA_SDK_VERSION ALLOW_AUDIO_PLAYBACK_CAPTURE ]
    pkgFlags=[ DEBUGGABLE HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]
    User 0: ceDataInode=565303 installed=true hidden=false suspended=false distractionFlags=0 stopped=false
`;

const RELEASE_DUMP = `
  /data/app/~~def==/com.callstack.agentdevicelab-UVW==/base.apk
    versionName=1.0.0
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]
    privateFlags=[ PRIVATE_FLAG_ALLOW_NATIVE_HEAP_POINTER_TAGGING ]
    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]
    User 0: ceDataInode=4421 installed=true hidden=false suspended=false distractionFlags=0 stopped=false
`;

const IDS = { appId: 'com.callstack.agentdevicelab', serial: 'emulator-5560' };

test('fixture facts read a debuggable dev-client build from its dumpsys flag lists', () => {
  assert.deepEqual(parseAndroidPackageFacts(DEV_CLIENT_DUMP), {
    installed: true,
    debuggable: true,
    devClient: true,
  });
});

test('fixture facts read a Release fixture as installed, debuggable-free and without the dev launcher', () => {
  assert.deepEqual(parseAndroidPackageFacts(RELEASE_DUMP), {
    installed: true,
    debuggable: false,
    devClient: false,
  });
});

test('fixture facts read an unknown package as not installed', () => {
  assert.deepEqual(
    parseAndroidPackageFacts('Unable to find package: com.callstack.agentdevicelab'),
    { installed: false, debuggable: false, devClient: false },
  );
});

test('a Release fixture has no preflight problem', () => {
  assert.equal(androidReleaseFixtureProblem(parseAndroidPackageFacts(RELEASE_DUMP), IDS), null);
});

test('a debuggable build names the install command even without the dev launcher', () => {
  const debuggableReleaseLayout = RELEASE_DUMP.replace(
    'flags=[ HAS_CODE',
    'flags=[ DEBUGGABLE HAS_CODE',
  );
  const facts = parseAndroidPackageFacts(debuggableReleaseLayout);
  assert.equal(facts.debuggable, true);
  const problem = androidReleaseFixtureProblem(facts, IDS);
  assert.match(problem!, /debuggable build, not the Release fixture/);
  assert.match(problem!, /pnpm test-app:android:fixture --serial emulator-5560/);
});

test('a dev-client build that is not debuggable still fails on the dev launcher', () => {
  const problem = androidReleaseFixtureProblem(
    parseAndroidPackageFacts(DEV_CLIENT_DUMP.replaceAll('DEBUGGABLE ', '')),
    IDS,
  );
  assert.match(problem!, /dev-client build \(expo-dev-launcher\)/);
});

test('a missing fixture names the install command', () => {
  const problem = androidReleaseFixtureProblem(parseAndroidPackageFacts(''), IDS);
  assert.match(problem!, /is not installed on emulator-5560/);
});

test('resolveAdb takes an SDK platform-tools binary that exists and falls back to PATH', () => {
  const sdk = mkdtempForTestSync('perf-adb-sdk-');
  fs.mkdirSync(path.join(sdk, 'platform-tools'));
  const adb = path.join(sdk, 'platform-tools', 'adb');
  fs.writeFileSync(adb, '');
  assert.equal(resolveAdb({ ANDROID_HOME: sdk }), adb);
  assert.equal(resolveAdb({ ANDROID_HOME: path.join(sdk, 'no-such-sdk') }), 'adb');
});

test('a package removed for the user is not installed', () => {
  const removed = `Packages:\n  Package [${IDS.appId}] (1):\n    flags=[ HAS_CODE ]\n    User 0: ceDataInode=0 installed=false hidden=false\n`;
  assert.equal(parseAndroidPackageFacts(removed).installed, false);
});

test('a non-default app id names the problem without the default installer', () => {
  const problem = androidReleaseFixtureProblem(parseAndroidPackageFacts(''), {
    appId: 'com.other.app',
    serial: 'emulator-5560',
  });
  assert.equal(problem, 'Android fixture preflight: com.other.app is not installed on emulator-5560.');
});
