import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createLiveDeviceContext,
  createLiveDeviceHarness,
  requiredEnv,
  type LiveDeviceContext,
} from '../live-device-e2e/runtime.ts';
import type { AndroidEmulatorBehaviorId } from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage-manifest.ts';
import { liveBehaviorsForScenario, writeCoverageReport } from './live-coverage-report.ts';

export { assertCoverageComplete, writeCoverageReport } from './live-coverage-report.ts';

export type Tier = 'smoke' | 'full';

export type LiveContext = LiveDeviceContext<AndroidEmulatorBehaviorId> & {
  appId: string;
  appPath: string;
  serial: string;
  tier: Tier;
};

export function createContext(): LiveContext {
  const tier = requiredEnv('AGENT_DEVICE_ANDROID_E2E_TIER', 'AGENT_DEVICE_ANDROID_E2E');
  assertTier(tier);
  return {
    ...createLiveDeviceContext<AndroidEmulatorBehaviorId>({
      artifactRoot: 'test/artifacts/android-emulator',
      session: `android-e2e-${process.pid.toString(36)}`,
    }),
    appId: requiredEnv('AGENT_DEVICE_FIXTURE_APP_ID', 'AGENT_DEVICE_ANDROID_E2E'),
    appPath: requiredEnv('AGENT_DEVICE_FIXTURE_APP_PATH', 'AGENT_DEVICE_ANDROID_E2E'),
    serial: requiredEnv('AGENT_DEVICE_ANDROID_SERIAL', 'AGENT_DEVICE_ANDROID_E2E'),
    tier,
  };
}

const execFileAsync = promisify(execFile);

/**
 * What the OS says about rotation when a step fails: the two settings `orientation` writes, the
 * display's current rotation, and every WindowManager rotation decision logcat still holds (with
 * the reason it gives). Read through adb, not agent-device, so it stands even when the CLI path
 * is what failed.
 */
async function readAndroidRotationEvidence(context: LiveContext): Promise<string> {
  const probes: readonly [string, string[]][] = [
    ['accelerometer_rotation', ['shell', 'settings', 'get', 'system', 'accelerometer_rotation']],
    ['user_rotation', ['shell', 'settings', 'get', 'system', 'user_rotation']],
    ['display rotation', ['shell', 'dumpsys', 'display']],
    ['logcat rotation decisions', ['logcat', '-d', '-v', 'time']],
  ];
  const sections: string[] = [];
  for (const [title, args] of probes) {
    try {
      const { stdout } = await execFileAsync('adb', ['-s', context.serial, ...args], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: 20_000,
      });
      sections.push(`## ${title}\n${selectRotationLines(title, stdout)}`);
    } catch (error) {
      sections.push(
        `## ${title}\n(failed: ${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return `${sections.join('\n\n')}\n`;
}

function selectRotationLines(title: string, output: string): string {
  if (title === 'display rotation') {
    return output
      .split('\n')
      .filter((line) =>
        /mCurrentOrientation|mRotation=|installOrientation|\brotation \d/.test(line),
      )
      .map((line) => line.trim().slice(0, 200))
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
      .slice(-60)
      .join('\n');
  }
  return output.trim();
}

const harness = createLiveDeviceHarness<LiveContext, AndroidEmulatorBehaviorId>({
  behaviorsForScenario: liveBehaviorsForScenario,
  commandsForScenario: liveCommandsForScenario,
  deviceEvidence: readAndroidRotationEvidence,
  commonFlags: (context, args) => [
    ...args,
    '--platform',
    'android',
    '--serial',
    context.serial,
    '--session',
    context.session,
    '--daemon-server-mode',
    'dual',
    ...(args.includes('--json') ? [] : ['--json']),
  ],
  writeCoverageReport,
});

export const {
  runScenario,
  runStep,
  sessionExists,
  verifyBehavior,
  verifyCommand,
  verifyNestedCommand: verifyNestedReplayCommand,
} = harness;

export async function cleanupSession(context: LiveContext): Promise<void> {
  const failures: unknown[] = [];
  if (context.tier === 'full') {
    for (const [step, args] of [
      ['bind fixture before Android permission reset', ['open', context.appId]],
      ['reset Android microphone permission', ['settings', 'permission', 'reset', 'microphone']],
    ] as const) {
      try {
        await runStep(context, `cleanup: ${step}`, [...args]);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (context.sessionOpen) {
    for (const [step, args] of [
      ['restore portrait orientation', ['orientation', 'portrait']],
      ['close fixture session', ['close']],
    ] as const) {
      try {
        await runStep(context, `cleanup: ${step}`, [...args]);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 0) return;
  const errorPath = path.join(context.artifactDir, 'cleanup-error.txt');
  fs.writeFileSync(errorPath, failures.map(String).join('\n\n'));
  throw new AggregateError(failures, `Android E2E cleanup failed; details: ${errorPath}`);
}

function assertTier(value: string): asserts value is Tier {
  if (value === 'smoke' || value === 'full') return;
  throw new Error(`unsupported Android E2E tier: ${value}`);
}
