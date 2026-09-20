import assert from 'node:assert/strict';
import test from 'node:test';

import { readAndroidDeviceEvidence, type AndroidAdbRead } from './device-evidence.ts';

const TARGET = { appId: 'com.callstack.agentdevicelab', serial: 'emulator-5554' };

type FakeDevice = {
  crashBuffer?: string;
  pid?: string;
  resumedActivity?: string;
};

function replayDevice(device: FakeDevice): AndroidAdbRead {
  return async (args) => {
    const query = args.join(' ');
    if (query.includes('pidof')) return device.pid ?? '';
    if (query.includes('dumpsys activity')) return device.resumedActivity ?? '';
    if (query.includes('-b crash')) return device.crashBuffer ?? '';
    if (query.includes('dumpsys display')) return '  mCurrentOrientation=0\n  mRotation=0\n';
    if (query.includes('logcat')) return '';
    return '0';
  };
}

test('a dropped process with a launcher activity reads as a crash and names the library', async () => {
  const evidence = await readAndroidDeviceEvidence(
    TARGET,
    replayDevice({
      pid: '',
      resumedActivity: [
        '  * Task{b3f2a1 #33 type=standard A=10247:com.google.android.apps.nexuslauncher}',
        '  topResumedActivity=ActivityRecord{7c1d9e2 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}',
        '  mFocusedApp=ActivityRecord{7c1d9e2 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}',
      ].join('\n'),
      crashBuffer: [
        'E/AndroidRuntime(12345): FATAL EXCEPTION: mqt_native_modules',
        'E/AndroidRuntime(12345): Process: com.callstack.agentdevicelab, PID: 12345',
        'E/AndroidRuntime(12345): java.lang.UnsatisfiedLinkError: dlopen failed: libgesturehandler.so',
        'E/AndroidRuntime(12345): \tat com.swmansion.gesturehandler.RNGestureHandlerModule.<clinit>(RNGestureHandlerModule.kt:14)',
      ].join('\n'),
    }),
  );

  const appProcess = section(evidence, 'app process');
  assert.equal(appProcess, '', 'a dead process must read as an empty pid, not as noise');
  assert.match(section(evidence, 'resumed activity'), /nexuslauncher\/\.NexusLauncherActivity/);
  assert.match(section(evidence, 'crash buffer'), /FATAL EXCEPTION: mqt_native_modules/);
  assert.match(section(evidence, 'crash buffer'), /RNGestureHandlerModule/);
});

test('an alive process keeps its record hash so a navigation is not mistaken for a restart', async () => {
  const evidence = await readAndroidDeviceEvidence(
    TARGET,
    replayDevice({
      pid: '12345',
      resumedActivity: [
        '  * Task{a1b2c3 #41 type=standard A=10248:com.callstack.agentdevicelab}',
        '  mResumedActivity: ActivityRecord{5f6a7b8 u0 com.callstack.agentdevicelab/.MainActivity t41}',
      ].join('\n'),
    }),
  );

  const activity = section(evidence, 'resumed activity');
  assert.equal(section(evidence, 'app process'), '12345');
  assert.match(
    activity,
    /ActivityRecord\{5f6a7b8 u0 com\.callstack\.agentdevicelab\/\.MainActivity/,
  );
  assert.ok(!activity.includes('* Task{'), 'task rows carry no focus information');
});

test('one failing probe records its failure without taking the rest of the document down', async () => {
  const read: AndroidAdbRead = async (args) => {
    if (args.join(' ').includes('-b crash')) throw new Error('adb: device offline');
    return '0';
  };

  const evidence = await readAndroidDeviceEvidence(TARGET, read);

  assert.match(section(evidence, 'crash buffer'), /\(failed: adb: device offline\)/);
  assert.equal(section(evidence, 'user_rotation'), '0');
  assert.match(section(evidence, 'app process'), /^0$/);
});

function section(evidence: string, title: string): string {
  const match = new RegExp(`## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(evidence);
  assert.ok(match, `evidence is missing the "${title}" section`);
  // Sections are joined with a blank line, so the capture always keeps the separator's newline.
  return match[1]!.replace(/\n$/, '');
}
