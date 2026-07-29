import fs from 'node:fs';
import path from 'node:path';

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

export type LiveContext = LiveDeviceContext<AndroidEmulatorBehaviorId> & {
  appId: string;
  appPath: string;
  serial: string;
};

export function createContext(): LiveContext {
  return {
    ...createLiveDeviceContext<AndroidEmulatorBehaviorId>({
      artifactRoot: 'test/artifacts/android-emulator',
      session: `android-e2e-${process.pid.toString(36)}`,
    }),
    appId: requiredEnv('AGENT_DEVICE_FIXTURE_APP_ID', 'AGENT_DEVICE_ANDROID_E2E'),
    appPath: requiredEnv('AGENT_DEVICE_FIXTURE_APP_PATH', 'AGENT_DEVICE_ANDROID_E2E'),
    serial: requiredEnv('AGENT_DEVICE_ANDROID_SERIAL', 'AGENT_DEVICE_ANDROID_E2E'),
  };
}

const harness = createLiveDeviceHarness<LiveContext, AndroidEmulatorBehaviorId>({
  behaviorsForScenario: liveBehaviorsForScenario,
  commandsForScenario: liveCommandsForScenario,
  commonFlags: (context, args) => [
    ...args,
    '--platform',
    'android',
    '--serial',
    context.serial,
    '--session',
    context.session,
    ...(args.includes('--json') ? [] : ['--json']),
  ],
  writeCoverageReport,
});

export const { runScenario, runStep, sessionExists, verifyBehavior, verifyCommand } = harness;

export async function cleanupSession(context: LiveContext): Promise<void> {
  const failures: unknown[] = [];
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
