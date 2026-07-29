import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { type CliJsonResult, formatResultDebug, runBuiltCliJson } from '../cli-json.ts';
import type { AndroidEmulatorBehaviorId } from './behavior-coverage.ts';
import { liveCommandsForScenario } from './coverage-manifest.ts';
import { liveBehaviorsForScenario, writeCoverageReport } from './live-coverage-report.ts';

export { assertCoverageComplete, writeCoverageReport } from './live-coverage-report.ts';

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

export type ScenarioTiming = {
  durationMs: number;
  id: string;
};

export type LiveContext = {
  appId: string;
  appPath: string;
  artifactDir: string;
  behaviorEvidence: Partial<Record<AndroidEmulatorBehaviorId, string[]>>;
  commandEvidence: Record<string, string[]>;
  completedScenarios: string[];
  currentScenario: string;
  env: NodeJS.ProcessEnv;
  serial: string;
  session: string;
  sessionOpen: boolean;
  startedAtMs: number;
  stepHistory: StepRecord[];
  timings: ScenarioTiming[];
};

export function createContext(): LiveContext {
  const runId = `${Date.now()}-${process.pid}`;
  const artifactDir = path.resolve('test/artifacts/android-emulator', runId);
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
    serial: requiredEnv('AGENT_DEVICE_ANDROID_SERIAL'),
    session: `android-e2e-${process.pid.toString(36)}`,
    sessionOpen: false,
    startedAtMs: Date.now(),
    stepHistory: [],
    timings: [],
  };
}

export async function runScenario(
  context: LiveContext,
  scenario: { id: string; run: (context: LiveContext) => Promise<void> },
): Promise<void> {
  context.currentScenario = scenario.id;
  const commandCounts = new Map(
    liveCommandsForScenario(scenario.id).map((command) => [
      command,
      context.commandEvidence[command]?.length ?? 0,
    ]),
  );
  const behaviorCounts = new Map(
    liveBehaviorsForScenario(scenario.id).map((behavior) => [
      behavior,
      context.behaviorEvidence[behavior]?.length ?? 0,
    ]),
  );
  const startedAt = Date.now();
  try {
    await scenario.run(context);
    assertNewEvidence(context, scenario.id, commandCounts, behaviorCounts);
    context.completedScenarios.push(scenario.id);
  } finally {
    context.timings.push({ durationMs: Date.now() - startedAt, id: scenario.id });
    writeCoverageReport(context);
  }
}

export async function runStep(
  context: LiveContext,
  step: string,
  args: string[],
  options: { commonFlags?: boolean; timeoutMs?: number } = {},
): Promise<CliJsonResult> {
  const fullArgs = options.commonFlags === false ? withJson(args) : withCommonFlags(context, args);
  const startedAt = Date.now();
  if (args[0] === 'open') context.sessionOpen = true;
  const result = await runBuiltCliJson(fullArgs, context.env, { timeoutMs: options.timeoutMs });
  context.stepHistory.push({
    accepted: result.status === 0,
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
  if (result.status !== 0) {
    const message = [
      formatResultDebug(step, fullArgs, result),
      `scenario: ${context.currentScenario}`,
      `artifacts: ${context.artifactDir}`,
    ].join('\n');
    fs.writeFileSync(path.join(context.artifactDir, 'failed-step.txt'), message);
    assert.fail(message);
  }
  if (args[0] === 'close') context.sessionOpen = false;
  return result;
}

export function verifyCommand(context: LiveContext, command: string, evidence: string): void {
  assert.ok(
    context.stepHistory.some(
      (step) =>
        step.scenario === context.currentScenario && step.commandName === command && step.accepted,
    ),
    `${context.currentScenario} credited ${command} without successful command execution`,
  );
  context.commandEvidence[command] = [...(context.commandEvidence[command] ?? []), evidence];
}

export function verifyBehavior(
  context: LiveContext,
  behavior: AndroidEmulatorBehaviorId,
  evidence: string,
): void {
  context.behaviorEvidence[behavior] = [...(context.behaviorEvidence[behavior] ?? []), evidence];
}

export async function cleanupSession(context: LiveContext): Promise<void> {
  const failures: unknown[] = [];
  if (context.sessionOpen) {
    try {
      await runStep(context, 'cleanup: restore portrait orientation', ['orientation', 'portrait']);
    } catch (error) {
      failures.push(error);
    }
    try {
      await runStep(context, 'cleanup: close fixture session', ['close']);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0) return;
  const errorPath = path.join(context.artifactDir, 'cleanup-error.txt');
  fs.writeFileSync(errorPath, failures.map(String).join('\n\n'));
  throw new AggregateError(failures, `Android E2E cleanup failed; details: ${errorPath}`);
}

function assertNewEvidence(
  context: LiveContext,
  scenarioId: string,
  commandCounts: ReadonlyMap<string, number>,
  behaviorCounts: ReadonlyMap<AndroidEmulatorBehaviorId, number>,
): void {
  for (const command of liveCommandsForScenario(scenarioId)) {
    assert.ok(
      (context.commandEvidence[command]?.length ?? 0) > (commandCounts.get(command) ?? 0),
      `${scenarioId} produced no command-specific evidence for ${command}`,
    );
  }
  for (const behavior of liveBehaviorsForScenario(scenarioId)) {
    assert.ok(
      (context.behaviorEvidence[behavior]?.length ?? 0) > (behaviorCounts.get(behavior) ?? 0),
      `${scenarioId} produced no behavior evidence for ${behavior}`,
    );
  }
}

function withCommonFlags(context: LiveContext, args: string[]): string[] {
  return [
    ...args,
    '--platform',
    'android',
    '--serial',
    context.serial,
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
  assert.ok(value, `${name} is required when AGENT_DEVICE_ANDROID_E2E=1`);
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
