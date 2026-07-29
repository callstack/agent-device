import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { resolveDaemonPaths } from '../../../src/daemon/config.ts';
import { type CliJsonResult, formatResultDebug, runBuiltCliJson } from '../cli-json.ts';
import { type IosSimulatorBehaviorId } from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage-manifest.ts';
import { liveBehaviorsForScenario, writeCoverageReport } from './live-coverage-report.ts';

export { assertCoverageComplete, writeCoverageReport } from './live-coverage-report.ts';

export type Tier = 'smoke' | 'full';

type StepRecord = {
  accepted: boolean;
  command: string;
  commandName?: string;
  durationMs: number;
  errorCode?: string;
  errorMessage?: string;
  scenario: string;
  status: number;
  step: string;
};

export type LiveContext = {
  appId: string;
  appPath: string;
  artifactDir: string;
  behaviorEvidence: Partial<Record<IosSimulatorBehaviorId, string[]>>;
  commandEvidence: Record<string, string[]>;
  completedScenarios: string[];
  currentScenario: string;
  env: NodeJS.ProcessEnv;
  session: string;
  sessionOpen: boolean;
  stateDir: string;
  stepHistory: StepRecord[];
  tier: Tier;
  udid: string;
};

export function createContext(): LiveContext {
  const tier = requiredEnv('AGENT_DEVICE_IOS_E2E_TIER');
  assert.ok(tier === 'smoke' || tier === 'full', `unsupported iOS E2E tier: ${tier}`);
  if (tier === 'full') requiredEnv('AGENT_DEVICE_IOS_APP_EVENT_URL_TEMPLATE');
  const runId = `${Date.now()}-${process.pid}`;
  const artifactDir = path.resolve('test/artifacts/ios-simulator', tier, runId);
  fs.mkdirSync(artifactDir, { recursive: true });

  return {
    appId: requiredEnv('AGENT_DEVICE_FIXTURE_APP_ID'),
    appPath: requiredEnv('AGENT_DEVICE_FIXTURE_APP_PATH'),
    artifactDir,
    behaviorEvidence: {},
    commandEvidence: {},
    completedScenarios: [],
    currentScenario: 'bootstrap',
    env: process.env,
    session: `ios-e2e-${tier}-${process.pid.toString(36)}`,
    sessionOpen: false,
    stateDir: resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR, {
      env: process.env,
    }).baseDir,
    stepHistory: [],
    tier,
    udid: requiredEnv('AGENT_DEVICE_IOS_UDID'),
  };
}

export async function runScenario(
  context: LiveContext,
  scenario: {
    id: string;
    run: (context: LiveContext) => Promise<void>;
  },
): Promise<void> {
  context.currentScenario = scenario.id;
  const commands = liveCommandsForScenario(scenario.id);
  const evidenceCounts = new Map(
    commands.map((command) => [command, context.commandEvidence[command]?.length ?? 0]),
  );
  const behaviorCounts = new Map(
    liveBehaviorsForScenario(scenario.id).map((behavior) => [
      behavior,
      context.behaviorEvidence[behavior]?.length ?? 0,
    ]),
  );
  await scenario.run(context);
  assertScenarioCommandsVerified(scenario.id, commands, context, evidenceCounts);
  assertScenarioBehaviorsVerified(scenario.id, context, behaviorCounts);
  context.completedScenarios.push(scenario.id);
  writeCoverageReport(context);
}

export async function runStep(
  context: LiveContext,
  step: string,
  args: string[],
  options: {
    allowFailure?: boolean;
    commonFlags?: boolean;
    expectFailure?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<CliJsonResult> {
  const fullArgs = options.commonFlags === false ? withJson(args) : withCommonFlags(context, args);
  const startedAt = Date.now();
  const result = await runBuiltCliJson(fullArgs, context.env, {
    timeoutMs: options.timeoutMs,
  });
  context.stepHistory.push({
    accepted: result.status === 0 || (options.expectFailure === true && result.status !== 0),
    command: `agent-device ${fullArgs.join(' ')}`,
    commandName: args[0],
    durationMs: Date.now() - startedAt,
    errorCode: stringValue(result.json?.error?.code),
    errorMessage: stringValue(result.json?.error?.message),
    scenario: context.currentScenario,
    status: result.status,
    step,
  });
  writeStepHistory(context);
  const failedAsExpected = options.expectFailure === true && result.status !== 0;
  if (result.status !== 0 && !failedAsExpected && options.allowFailure !== true) {
    const message = [
      formatResultDebug(step, fullArgs, result),
      `scenario: ${context.currentScenario}`,
      `artifacts: ${context.artifactDir}`,
    ].join('\n');
    fs.writeFileSync(path.join(context.artifactDir, 'failed-step.txt'), message);
    assert.fail(message);
  }
  if (options.expectFailure === true && result.status === 0) {
    assert.fail(`${step} unexpectedly succeeded\ncommand: agent-device ${fullArgs.join(' ')}`);
  }
  if (result.status === 0 && args[0] === 'open') context.sessionOpen = true;
  if (result.status === 0 && args[0] === 'close') context.sessionOpen = false;
  return result;
}

export function verifyCommand(context: LiveContext, command: string, evidence: string): void {
  recordCommandEvidence(context, command, command, evidence);
}

export function verifyNestedReplayCommand(
  context: LiveContext,
  command: 'gesture' | 'swipe',
  executedVia: 'replay' | 'test',
  evidence: string,
): void {
  recordCommandEvidence(context, command, executedVia, evidence);
}

function recordCommandEvidence(
  context: LiveContext,
  command: string,
  executedCommand: string,
  evidence: string,
): void {
  assert.ok(
    context.stepHistory.some(
      (step) =>
        step.scenario === context.currentScenario &&
        step.commandName === executedCommand &&
        step.accepted,
    ),
    `${context.currentScenario} credited ${command} without a successful ${executedCommand} execution`,
  );
  const existing = context.commandEvidence[command] ?? [];
  context.commandEvidence[command] = [...existing, evidence];
}

export function verifyBehavior(
  context: LiveContext,
  behavior: IosSimulatorBehaviorId,
  evidence: string,
): void {
  const existing = context.behaviorEvidence[behavior] ?? [];
  context.behaviorEvidence[behavior] = [...existing, evidence];
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

export async function sessionExists(context: LiveContext): Promise<boolean> {
  const inventory = await runStep(context, 'inspect final session ownership', ['session', 'list'], {
    commonFlags: false,
  });
  const sessions = Array.isArray(inventory.json?.data?.sessions)
    ? inventory.json.data.sessions
    : [];
  return sessions.some((session: { name?: unknown }) => session.name === context.session);
}

function assertScenarioCommandsVerified(
  scenarioId: string,
  commands: readonly string[],
  context: LiveContext,
  evidenceCounts: ReadonlyMap<string, number>,
): void {
  for (const command of commands) {
    const before = evidenceCounts.get(command) ?? 0;
    const after = context.commandEvidence[command]?.length ?? 0;
    assert.ok(after > before, `${scenarioId} produced no command-specific evidence for ${command}`);
  }
}

function assertScenarioBehaviorsVerified(
  scenarioId: string,
  context: LiveContext,
  evidenceCounts: ReadonlyMap<IosSimulatorBehaviorId, number>,
): void {
  for (const behavior of liveBehaviorsForScenario(scenarioId)) {
    const before = evidenceCounts.get(behavior) ?? 0;
    const after = context.behaviorEvidence[behavior]?.length ?? 0;
    assert.ok(after > before, `${scenarioId} produced no behavior evidence for ${behavior}`);
  }
}

function withCommonFlags(context: LiveContext, args: string[]): string[] {
  return [
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
  ];
}

function withJson(args: string[]): string[] {
  return args.includes('--json') ? args : [...args, '--json'];
}

function writeStepHistory(context: LiveContext): void {
  fs.writeFileSync(
    path.join(context.artifactDir, 'step-history.json'),
    JSON.stringify(context.stepHistory, null, 2),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required when AGENT_DEVICE_IOS_E2E=1`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
