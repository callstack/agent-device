import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDaemonPaths } from '../../../src/daemon/config.ts';
import {
  createLiveDeviceContext,
  createLiveDeviceHarness,
  requiredEnv,
  type LiveDeviceContext,
} from '../live-device-e2e/runtime.ts';
import type { IosSimulatorBehaviorId } from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage-manifest.ts';
import { liveBehaviorsForScenario, writeCoverageReport } from './live-coverage-report.ts';

export { assertCoverageComplete, writeCoverageReport } from './live-coverage-report.ts';

export type Tier = 'smoke' | 'full';

export type LiveContext = LiveDeviceContext<IosSimulatorBehaviorId> & {
  appId: string;
  appPath: string;
  stateDir: string;
  tier: Tier;
  udid: string;
};

export function createContext(): LiveContext {
  const tier = requiredEnv('AGENT_DEVICE_IOS_E2E_TIER', 'AGENT_DEVICE_IOS_E2E');
  assert.ok(tier === 'smoke' || tier === 'full', `unsupported iOS E2E tier: ${tier}`);
  if (tier === 'full') {
    requiredEnv('AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE', 'AGENT_DEVICE_IOS_E2E');
  }
  return {
    ...createLiveDeviceContext<IosSimulatorBehaviorId>({
      artifactRoot: `test/artifacts/ios-simulator/${tier}`,
      session: `ios-e2e-${tier}-${process.pid.toString(36)}`,
    }),
    appId: requiredEnv('AGENT_DEVICE_FIXTURE_APP_ID', 'AGENT_DEVICE_IOS_E2E'),
    appPath: requiredEnv('AGENT_DEVICE_FIXTURE_APP_PATH', 'AGENT_DEVICE_IOS_E2E'),
    stateDir: resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR, {
      env: process.env,
    }).baseDir,
    tier,
    udid: requiredEnv('AGENT_DEVICE_IOS_UDID', 'AGENT_DEVICE_IOS_E2E'),
  };
}

const harness = createLiveDeviceHarness<LiveContext, IosSimulatorBehaviorId>({
  behaviorsForScenario: liveBehaviorsForScenario,
  commandsForScenario: liveCommandsForScenario,
  commonFlags: (context, args) => [
    ...args,
    '--platform',
    'ios',
    '--udid',
    context.udid,
    '--session',
    context.session,
    '--state-dir',
    context.stateDir,
    ...(args.includes('--json') ? [] : ['--json']),
  ],
  writeCoverageReport,
});

export const { runScenario, runStep, sessionExists, verifyBehavior, verifyCommand } = harness;

export function verifyNestedReplayCommand(
  context: LiveContext,
  command: 'gesture' | 'swipe',
  executedVia: 'replay' | 'test',
  evidence: string,
): void {
  harness.verifyNestedCommand(context, command, executedVia, evidence);
}

export async function cleanupSession(context: LiveContext): Promise<void> {
  const failures: unknown[] = [];
  const cleanupSteps: Array<[string, string[]]> = [];
  if (context.tier === 'full') {
    cleanupSteps.push(
      ['reset microphone permission', ['settings', 'permission', 'reset', 'microphone']],
      ['restore light appearance', ['settings', 'appearance', 'light']],
      ['restore portrait orientation', ['orientation', 'portrait']],
    );
  }
  cleanupSteps.push(['close fixture session', ['close']]);
  for (const [step, args] of cleanupSteps) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const result = await runStep(context, `cleanup: ${step} (attempt ${attempt})`, args, {
          allowFailure: attempt < 3,
        });
        if (result.status === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        failures.push(error);
        break;
      }
    }
  }
  if (failures.length === 0) return;
  const errorPath = path.join(context.artifactDir, 'cleanup-error.txt');
  fs.writeFileSync(errorPath, failures.map(String).join('\n\n'));
  throw new AggregateError(failures, `iOS E2E cleanup failed; details: ${errorPath}`);
}
