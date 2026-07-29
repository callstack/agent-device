import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { type CliJsonResult, formatResultDebug, runBuiltCliJson } from '../cli-json.ts';

export type StepRecord = {
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

export type LiveDeviceContext<BehaviorId extends string> = {
  artifactDir: string;
  behaviorEvidence: Partial<Record<BehaviorId, string[]>>;
  commandEvidence: Record<string, string[]>;
  completedScenarios: string[];
  currentScenario: string;
  env: NodeJS.ProcessEnv;
  session: string;
  sessionOpen: boolean;
  startedAtMs: number;
  stepHistory: StepRecord[];
  timings: ScenarioTiming[];
};

export type LiveScenario<Context> = {
  id: string;
  run: (context: Context) => Promise<void>;
};

type HarnessOptions<Context, BehaviorId extends string> = {
  behaviorsForScenario: (scenarioId: string) => readonly BehaviorId[];
  commandsForScenario: (scenarioId: string) => readonly string[];
  commonFlags: (context: Context, args: readonly string[]) => string[];
  writeCoverageReport: (context: Context) => void;
};

type RunStepOptions = {
  allowFailure?: boolean;
  commonFlags?: boolean;
  expectFailure?: boolean;
  timeoutMs?: number;
};

export function createLiveDeviceContext<BehaviorId extends string>(options: {
  artifactRoot: string;
  session: string;
}): LiveDeviceContext<BehaviorId> {
  const runId = `${Date.now()}-${process.pid}`;
  const artifactDir = path.resolve(options.artifactRoot, runId);
  fs.mkdirSync(artifactDir, { recursive: true });
  return {
    artifactDir,
    behaviorEvidence: {},
    commandEvidence: {},
    completedScenarios: [],
    currentScenario: 'bootstrap',
    env: process.env,
    session: options.session,
    sessionOpen: false,
    startedAtMs: Date.now(),
    stepHistory: [],
    timings: [],
  };
}

export function createLiveDeviceHarness<
  Context extends LiveDeviceContext<BehaviorId>,
  BehaviorId extends string,
>(options: HarnessOptions<Context, BehaviorId>) {
  async function runScenario(context: Context, scenario: LiveScenario<Context>): Promise<void> {
    context.currentScenario = scenario.id;
    const commandCounts = evidenceCounts(
      options.commandsForScenario(scenario.id),
      context.commandEvidence,
    );
    const behaviorCounts = evidenceCounts(
      options.behaviorsForScenario(scenario.id),
      context.behaviorEvidence,
    );
    const startedAt = Date.now();
    try {
      await scenario.run(context);
      assertNewEvidence(
        scenario.id,
        options.commandsForScenario(scenario.id),
        context.commandEvidence,
        commandCounts,
      );
      assertNewEvidence(
        scenario.id,
        options.behaviorsForScenario(scenario.id),
        context.behaviorEvidence,
        behaviorCounts,
      );
      context.completedScenarios.push(scenario.id);
    } finally {
      context.timings.push({ durationMs: Date.now() - startedAt, id: scenario.id });
      options.writeCoverageReport(context);
    }
  }

  async function runStep(
    context: Context,
    step: string,
    args: string[],
    stepOptions: RunStepOptions = {},
  ): Promise<CliJsonResult> {
    const fullArgs = buildStepArgs(context, args, stepOptions);
    const startedAt = Date.now();
    const result = await runBuiltCliJson(fullArgs, context.env, {
      timeoutMs: stepOptions.timeoutMs,
    });
    const failedAsExpected = stepOptions.expectFailure === true && result.status !== 0;
    recordStep(context, {
      accepted: result.status === 0 || failedAsExpected,
      command: `agent-device ${fullArgs.join(' ')}`,
      commandName: args[0],
      durationMs: Date.now() - startedAt,
      errorCode: stringValue(result.json?.error?.code),
      errorMessage: stringValue(result.json?.error?.message),
      scenario: context.currentScenario,
      status: result.status,
      step,
    });
    assertStepOutcome(context, step, fullArgs, result, failedAsExpected, stepOptions);
    updateSessionState(context, args[0], result.status);
    return result;
  }

  function buildStepArgs(
    context: Context,
    args: readonly string[],
    stepOptions: RunStepOptions,
  ): string[] {
    return stepOptions.commonFlags === false ? withJson(args) : options.commonFlags(context, args);
  }

  function recordStep(context: Context, record: StepRecord): void {
    context.stepHistory.push(record);
    writeStepHistory(context);
  }

  function assertStepOutcome(
    context: Context,
    step: string,
    fullArgs: string[],
    result: CliJsonResult,
    failedAsExpected: boolean,
    stepOptions: RunStepOptions,
  ): void {
    const unexpectedFailure =
      result.status !== 0 && !failedAsExpected && stepOptions.allowFailure !== true;
    if (unexpectedFailure) {
      const message = [
        formatResultDebug(step, fullArgs, result),
        `scenario: ${context.currentScenario}`,
        `artifacts: ${context.artifactDir}`,
      ].join('\n');
      fs.writeFileSync(path.join(context.artifactDir, 'failed-step.txt'), message);
      assert.fail(message);
    }
    if (stepOptions.expectFailure === true && result.status === 0) {
      assert.fail(`${step} unexpectedly succeeded\ncommand: agent-device ${fullArgs.join(' ')}`);
    }
  }

  function updateSessionState(context: Context, command: string | undefined, status: number): void {
    if (status !== 0) return;
    if (command === 'open') context.sessionOpen = true;
    if (command === 'close') context.sessionOpen = false;
  }

  function verifyCommand(context: Context, command: string, evidence: string): void {
    recordCommandEvidence(context, command, command, evidence);
  }

  function verifyNestedCommand(
    context: Context,
    command: string,
    executedCommand: string,
    evidence: string,
  ): void {
    recordCommandEvidence(context, command, executedCommand, evidence);
  }

  function recordCommandEvidence(
    context: Context,
    command: string,
    executedCommand: string,
    evidence: string,
  ): void {
    assert.ok(
      context.stepHistory.some(
        (record) =>
          record.scenario === context.currentScenario &&
          record.commandName === executedCommand &&
          record.accepted,
      ),
      `${context.currentScenario} credited ${command} without a successful ${executedCommand} execution`,
    );
    context.commandEvidence[command] = [...(context.commandEvidence[command] ?? []), evidence];
  }

  function verifyBehavior(context: Context, behavior: BehaviorId, evidence: string): void {
    context.behaviorEvidence[behavior] = [...(context.behaviorEvidence[behavior] ?? []), evidence];
  }

  async function sessionExists(context: Context): Promise<boolean> {
    const inventory = await runStep(
      context,
      'inspect final session ownership',
      ['session', 'list'],
      {
        commonFlags: false,
      },
    );
    const sessions = Array.isArray(inventory.json?.data?.sessions)
      ? inventory.json.data.sessions
      : [];
    return sessions.some((session: { name?: unknown }) => session.name === context.session);
  }

  return {
    runScenario,
    runStep,
    sessionExists,
    verifyBehavior,
    verifyCommand,
    verifyNestedCommand,
  };
}

export function requiredEnv(name: string, enabledFlag: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required when ${enabledFlag}=1`);
  return value;
}

function evidenceCounts<Key extends string>(
  keys: readonly Key[],
  evidence: Partial<Record<Key, string[]>>,
): ReadonlyMap<Key, number> {
  return new Map(keys.map((key) => [key, evidence[key]?.length ?? 0]));
}

function assertNewEvidence<Key extends string>(
  scenarioId: string,
  keys: readonly Key[],
  evidence: Partial<Record<Key, string[]>>,
  counts: ReadonlyMap<Key, number>,
): void {
  for (const key of keys) {
    assert.ok(
      (evidence[key]?.length ?? 0) > (counts.get(key) ?? 0),
      `${scenarioId} produced no specific evidence for ${key}`,
    );
  }
}

function withJson(args: readonly string[]): string[] {
  return args.includes('--json') ? [...args] : [...args, '--json'];
}

function writeStepHistory<BehaviorId extends string>(context: LiveDeviceContext<BehaviorId>): void {
  fs.writeFileSync(
    path.join(context.artifactDir, 'step-history.json'),
    JSON.stringify(context.stepHistory, null, 2),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
