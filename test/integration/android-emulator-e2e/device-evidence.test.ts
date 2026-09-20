import { expect, test } from 'vitest';

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

  expect(section(evidence, 'app process')).toBe('');
  expect(section(evidence, 'resumed activity')).toMatch(/nexuslauncher\/\.NexusLauncherActivity/);
  expect(section(evidence, 'crash buffer')).toMatch(/FATAL EXCEPTION: mqt_native_modules/);
  expect(section(evidence, 'crash buffer')).toMatch(/RNGestureHandlerModule/);
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

  expect(section(evidence, 'app process')).toBe('12345');
  expect(section(evidence, 'resumed activity')).toMatch(
    /ActivityRecord\{5f6a7b8 u0 com\.callstack\.agentdevicelab\/\.MainActivity/,
  );
  expect(section(evidence, 'resumed activity')).not.toContain('* Task{');
});

test('one failing probe records its failure without taking the rest of the document down', async () => {
  const read: AndroidAdbRead = async (args) => {
    if (args.join(' ').includes('-b crash')) throw new Error('adb: device offline');
    return '0';
  };

  const evidence = await readAndroidDeviceEvidence(TARGET, read);

  expect(section(evidence, 'crash buffer')).toMatch(/\(failed: adb: device offline\)/);
  expect(section(evidence, 'user_rotation')).toBe('0');
  expect(section(evidence, 'app process')).toBe('0');
});

/** Sections are joined with a blank line, so each capture keeps the separator's newline. */
function section(evidence: string, title: string): string {
  const match = new RegExp(`## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(evidence);
  expect(match, `evidence is missing the "${title}" section`).not.toBeNull();
  return match![1]!.replace(/\n$/, '');
}

test('the app id reaches the device shell as one word, never as a script', async () => {
  const seen: string[][] = [];
  const read: AndroidAdbRead = async (args) => {
    seen.push([...args]);
    return '0';
  };

  await readAndroidDeviceEvidence({ appId: 'com.lab', serial: 'emulator-5554' }, read);
  await readAndroidDeviceEvidence({ appId: "com.lab'; reboot", serial: 'emulator-5554' }, read);

  const pidof = seen.filter((args) => args.includes('pidof'));
  expect(pidof[0]).toEqual(['-s', 'emulator-5554', 'shell', 'pidof', 'com.lab']);
  expect(pidof[1]).toEqual([
    '-s',
    'emulator-5554',
    'shell',
    'pidof',
    String.raw`'com.lab'\''; reboot'`,
  ]);
});
