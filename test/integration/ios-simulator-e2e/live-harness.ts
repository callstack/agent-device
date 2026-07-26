import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { type CliJsonResult, formatResultDebug, runBuiltCliJson } from '../cli-json.ts';
import { type IosSimulatorBehaviorId } from './behavior-coverage.ts';
import { liveBehaviorsForScenario, writeCoverageReport } from './live-coverage-report.ts';
import { IOS_SIMULATOR_LIVE_SCENARIOS, type IosSimulatorScenario } from './scenarios.ts';

export { assertCoverageComplete, writeCoverageReport } from './live-coverage-report.ts';

export type Tier = 'smoke' | 'full';

type StepRecord = {
  command: string;
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
  stepHistory: StepRecord[];
  tier: Tier;
  udid: string;
};

export function createContext(): LiveContext {
  const tier = requiredEnv('AGENT_DEVICE_IOS_E2E_TIER');
  assert.ok(tier === 'smoke' || tier === 'full', `unsupported iOS E2E tier: ${tier}`);
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
    stepHistory: [],
    tier,
    udid: requiredEnv('AGENT_DEVICE_IOS_UDID'),
  };
}

export async function runScenario(
  context: LiveContext,
  id: string,
  run: () => Promise<void>,
): Promise<void> {
  const scenario = IOS_SIMULATOR_LIVE_SCENARIOS.find((candidate) => candidate.id === id);
  assert.ok(scenario, `missing live scenario metadata: ${id}`);
  context.currentScenario = id;
  const evidenceCounts = new Map(
    scenario.commands.map((command) => [command, context.commandEvidence[command]?.length ?? 0]),
  );
  const behaviorCounts = new Map(
    liveBehaviorsForScenario(id).map((behavior) => [
      behavior,
      context.behaviorEvidence[behavior]?.length ?? 0,
    ]),
  );
  await run();
  assertScenarioCommandsVerified(scenario, context, evidenceCounts);
  assertScenarioBehaviorsVerified(id, context, behaviorCounts);
  context.completedScenarios.push(id);
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
    command: `agent-device ${fullArgs.join(' ')}`,
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
  const existing = context.commandEvidence[command] ?? [];
  context.commandEvidence[command] = [...existing, evidence];
  writeCoverageReport(context);
}

export function verifyBehavior(
  context: LiveContext,
  behavior: IosSimulatorBehaviorId,
  evidence: string,
): void {
  const existing = context.behaviorEvidence[behavior] ?? [];
  context.behaviorEvidence[behavior] = [...existing, evidence];
  writeCoverageReport(context);
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
    try {
      await runStep(context, `cleanup: ${step}`, args);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  const errorPath = path.join(context.artifactDir, 'cleanup-error.txt');
  fs.writeFileSync(errorPath, failures.map(String).join('\n\n'));
  throw new AggregateError(failures, `iOS E2E cleanup failed; details: ${errorPath}`);
}

export async function withSessionCleanup<T>(
  context: LiveContext,
  run: () => Promise<T>,
): Promise<T> {
  let result!: T;
  let primaryError: unknown;
  try {
    result = await run();
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    const attempts = primaryError === undefined ? 1 : 15;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const inventory = await runStep(
        context,
        'inspect replay session cleanup',
        ['session', 'list'],
        {
          commonFlags: false,
        },
      );
      const sessions = Array.isArray(inventory.json?.data?.sessions)
        ? inventory.json.data.sessions
        : [];
      if (sessions.some((session: { name?: unknown }) => session.name === context.session)) {
        await runStep(context, 'close replay session after command', ['close']);
        break;
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [primaryError, cleanupError],
      'replay and session cleanup both failed',
    );
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
  return result;
}

function assertScenarioCommandsVerified(
  scenario: IosSimulatorScenario,
  context: LiveContext,
  evidenceCounts: ReadonlyMap<string, number>,
): void {
  for (const command of scenario.commands) {
    const before = evidenceCounts.get(command) ?? 0;
    const after = context.commandEvidence[command]?.length ?? 0;
    assert.ok(
      after > before,
      `${scenario.id} produced no command-specific evidence for ${command}`,
    );
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
