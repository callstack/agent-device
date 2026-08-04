import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDaemonPaths } from '../../../src/daemon/config.ts';
import type { CliJsonResult } from '../cli-json.ts';
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
  runnerLogPath?: string;
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

// Shared between the step list and the guard below so the two can't drift apart.
const MICROPHONE_PERMISSION_RESET_STEP = 'reset microphone permission';

export async function cleanupSession(context: LiveContext): Promise<void> {
  const failures: unknown[] = [];
  const cleanupSteps: Array<[string, string[]]> = [];
  if (context.tier === 'full') {
    cleanupSteps.push(
      [MICROPHONE_PERMISSION_RESET_STEP, ['settings', 'permission', 'reset', 'microphone']],
      ['restore light appearance', ['settings', 'appearance', 'light']],
      ['restore portrait orientation', ['orientation', 'portrait']],
    );
  }
  cleanupSteps.push(['close fixture session', ['close']]);
  for (const [step, args] of cleanupSteps) {
    const failure = await retryCleanupStep(step, (attempt) =>
      runStep(context, `cleanup: ${step} (attempt ${attempt})`, args, {
        allowFailure: attempt < 3,
      }),
    );
    if (failure !== undefined) failures.push(failure);
  }
  if (failures.length === 0) return;
  const errorPath = path.join(context.artifactDir, 'cleanup-error.txt');
  fs.writeFileSync(errorPath, failures.map(String).join('\n\n'));
  throw new AggregateError(failures, `iOS E2E cleanup failed; details: ${errorPath}`);
}

/**
 * Runs one cleanup step's 3-attempt retry policy: success or an already-clean session
 * stops immediately, anything else waits and retries. `runAttempt` mirrors the real
 * `runStep(..., { allowFailure: attempt < 3 })` contract, including that the final
 * attempt throws instead of returning a failed result. Exported so the retry/guard
 * behavior is unit-testable without spawning the CLI (see
 * `test/integration/ios-simulator-e2e-cleanup.test.ts`).
 */
export async function retryCleanupStep(
  step: string,
  runAttempt: (attempt: number) => Promise<CliJsonResult>,
): Promise<unknown> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await runAttempt(attempt);
      if (result.status === 0 || sessionAlreadyClean(step, result)) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      return error;
    }
  }
  return undefined;
}

// SESSION_NOT_FOUND: nothing left to reset, any step. INVALID_ARGS: only the
// mic-permission reset needs an app bundle and app-settings.ts has no reason code for
// it, so we match its exact message — scoped to this step so it can't hide another failure.
function sessionAlreadyClean(step: string, result: CliJsonResult): boolean {
  if (result.json?.error?.code === 'SESSION_NOT_FOUND') return true;
  return (
    step === MICROPHONE_PERMISSION_RESET_STEP &&
    result.json?.error?.code === 'INVALID_ARGS' &&
    result.json?.error?.message === 'permission setting requires an active app in session'
  );
}
