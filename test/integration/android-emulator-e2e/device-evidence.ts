/**
 * What the OS says about an Android device when an e2e step fails. Read through adb, not
 * agent-device, so the facts still stand when the CLI path is the thing that failed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { deviceShellArgv } from '@agent-device/kernel/device-shell';

const execFileAsync = promisify(execFile);

const DEVICE_PROBE_TIMEOUT_MS = 5_000;
/** Lines read back from logcat; the rotation decisions of the last few minutes fit comfortably. */
const ROTATION_LOG_TAIL = 4_000;
const ROTATION_LOG_LINES = 60;
const ROTATION_LOG_LINE_LENGTH = 240;
/** The crash buffer holds only recent crashes, so a tail is enough to carry a stack. */
const CRASH_LOG_TAIL = 400;
const RESUMED_ACTIVITY_LINES = 12;

/** The device a failed step ran against. */
export type AndroidDeviceEvidenceTarget = {
  appId: string;
  serial: string;
};

/** One adb query answered with its stdout. Tests replay a device through this. */
export type AndroidAdbRead = (args: readonly string[]) => Promise<string>;

/**
 * Rotation (the two settings `orientation` writes, the display's current rotation, and the
 * WindowManager decisions logcat still holds) plus whether the app is still running at all. Those
 * last three probes are what separates "the app crashed" from "the app navigated somewhere
 * unexpected": a `pidof` that returns nothing next to a launcher `mResumedActivity` is a crash, and
 * the crash buffer then names the library. The caller bounds this read so it never delays the
 * screenshot that follows.
 */
export async function readAndroidDeviceEvidence(
  target: AndroidDeviceEvidenceTarget,
  read: AndroidAdbRead = createAdbRead(),
): Promise<string> {
  // Addressing travels inside the same argv as the subcommand, which is the prefix form
  // `deviceShellArgv` documents for an adb `-s` route.
  const addressing = ['-s', target.serial];
  const probes: readonly [string, readonly string[]][] = [
    [
      'accelerometer_rotation',
      deviceShellArgv(
        'adb',
        'shell',
        ['settings', 'get', 'system', 'accelerometer_rotation'],
        addressing,
      ),
    ],
    [
      'user_rotation',
      deviceShellArgv('adb', 'shell', ['settings', 'get', 'system', 'user_rotation'], addressing),
    ],
    ['display rotation', deviceShellArgv('adb', 'shell', ['dumpsys', 'display'], addressing)],
    // The tail, not the whole buffer: the emulator keeps 2MB and a loaded one takes seconds to
    // dump it, which is what the group bound is for, not this read. These two are host-side adb
    // queries, so they carry addressing as plain argv and never reach the device shell.
    [
      'logcat rotation decisions',
      [...addressing, 'logcat', '-d', '-v', 'time', '-t', String(ROTATION_LOG_TAIL)],
    ],
    ['app process', deviceShellArgv('adb', 'shell', ['pidof', target.appId], addressing)],
    [
      'resumed activity',
      deviceShellArgv('adb', 'shell', ['dumpsys', 'activity', 'activities'], addressing),
    ],
    ['crash buffer', [...addressing, 'logcat', '-d', '-b', 'crash', '-v', 'time']],
  ];
  const sections: string[] = [];
  for (const [title, args] of probes) {
    try {
      sections.push(`## ${title}\n${selectDeviceEvidenceLines(title, await read(args))}`);
    } catch (error) {
      sections.push(
        `## ${title}\n(failed: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return `${sections.join('\n\n')}\n`;
}

function createAdbRead(): AndroidAdbRead {
  return async (args) => {
    const { stdout } = await execFileAsync('adb', args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: DEVICE_PROBE_TIMEOUT_MS,
    });
    return stdout;
  };
}

function selectDeviceEvidenceLines(title: string, output: string): string {
  if (title === 'display rotation') {
    return output
      .split('\n')
      .filter((line) =>
        /mCurrentOrientation|mRotation=|installOrientation|\brotation \d/.test(line),
      )
      .map((line) => line.trim().slice(0, ROTATION_LOG_LINE_LENGTH))
      .slice(0, 8)
      .join('\n');
  }
  if (title === 'logcat rotation decisions') {
    return output
      .split('\n')
      .filter(
        (line) =>
          /(WindowManager|DisplayRotation|WindowOrientationListener|RotationResolver|DisplayContent|SensorService)/.test(
            line,
          ) && /rotat|orient/i.test(line),
      )
      .slice(-ROTATION_LOG_LINES)
      .map((line) => line.slice(0, ROTATION_LOG_LINE_LENGTH))
      .join('\n');
  }
  if (title === 'resumed activity') {
    // Keeps the ActivityRecord hash with the component name: the same hash on a different
    // component is a navigation, a new hash is a process restart.
    return output
      .split('\n')
      .filter((line) =>
        /mResumedActivity|topResumedActivity|mFocusedApp|mStoppingActivity|mPausingActivity/.test(
          line,
        ),
      )
      .slice(0, RESUMED_ACTIVITY_LINES)
      .map((line) => line.trim().slice(0, ROTATION_LOG_LINE_LENGTH))
      .join('\n');
  }
  if (title === 'crash buffer') {
    return output
      .split('\n')
      .slice(-CRASH_LOG_TAIL)
      .map((line) => line.slice(0, ROTATION_LOG_LINE_LENGTH))
      .join('\n');
  }
  return output.trim();
}
