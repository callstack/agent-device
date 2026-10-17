import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';
import type { CliJsonResult } from '../cli-json.ts';
import {
  createLiveDeviceContext,
  createLiveDeviceHarness,
  requiredEnv,
  type LiveDeviceContext,
} from '../live-device-e2e/runtime.ts';
import type { IosSimulatorBehaviorId } from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage.ts';
import { isObservationPreventedStepMiss } from './live-step-retry-policy.ts';
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

// Repeat at most one typed observation failure. Scenario-owned retry loops disable this policy.
export function runStep(
  context: LiveContext,
  step: string,
  args: string[],
  options: Parameters<typeof harness.runStep>[3] = {},
): Promise<CliJsonResult> {
  return harness.runStep(context, step, args, {
    reattemptInfrastructureMiss: isObservationPreventedStepMiss,
    ...options,
  });
}

export const { runScenario, sessionExists, verifyBehavior, verifyCommand } = harness;

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
  context.currentScenario = 'cleanup';
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
        allowFailure: true,
        reattemptInfrastructureMiss: undefined,
      }),
    );
    if (failure !== undefined) {
      await harness.recordFailure(context, failure);
      failures.push(failure);
    }
  }
  if (failures.length === 0) return;
  const errorPath = path.join(context.artifactDir, 'cleanup-error.txt');
  fs.writeFileSync(errorPath, failures.map(String).join('\n\n'));
  throw new AggregateError(failures, `iOS E2E cleanup failed; details: ${errorPath}`);
}

/** Returns the failure after at most three attempts, or undefined when cleanup is complete. */
export async function retryCleanupStep(
  step: string,
  runAttempt: (attempt: number) => Promise<CliJsonResult>,
): Promise<unknown> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await runAttempt(attempt);
      if (result.status === 0 || sessionAlreadyClean(step, result)) return undefined;
      if (attempt === 3) {
        return new Error(
          `cleanup: ${step} failed after ${attempt} attempts: ${JSON.stringify(result)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      return error;
    }
  }
}

// SESSION_NOT_FOUND: nothing left to reset, any step. INVALID_ARGS with the published
// session-app reason: only the mic-permission reset needs an app bundle, and the refusal is
// scoped to this step so it can't hide another failure.
function sessionAlreadyClean(step: string, result: CliJsonResult): boolean {
  if (result.json?.error?.code === 'SESSION_NOT_FOUND') return true;
  return (
    step === MICROPHONE_PERMISSION_RESET_STEP &&
    result.json?.error?.code === 'INVALID_ARGS' &&
    result.json?.error?.details?.reason === PRE_DISPATCH_REFUSAL_REASONS.sessionAppRequired
  );
}
