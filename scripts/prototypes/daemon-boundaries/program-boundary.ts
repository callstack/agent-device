import assert from 'node:assert/strict';

type ProgramFormat = 'ad' | 'maestro';
type RunMode = 'pass' | 'fail';

type ProgramManifest = {
  format: ProgramFormat;
  sourcePath: string;
  caseNames: readonly string[];
};

type ProgramResult =
  | { outcome: 'passed'; artifacts: readonly string[] }
  | { outcome: 'failed'; code: string; artifacts: readonly string[] }
  | { outcome: 'diverged'; step: number; artifacts: readonly string[] };

interface TestProgramExecutor {
  inspect(sourcePath: string): Promise<ProgramManifest>;
  execute(sourcePath: string, mode: RunMode, signal: AbortSignal): Promise<ProgramResult>;
}

type AdAction =
  | { kind: 'open'; app: string }
  | { kind: 'click'; selector: string }
  | { kind: 'verify'; selector: string };

type PreparedAdReplay = {
  readonly digest: string;
  readonly actions: readonly AdAction[];
};

interface AdReplayRuntime {
  executeStep(
    action: AdAction,
    signal: AbortSignal,
  ): Promise<{ outcome: 'completed' } | { outcome: 'diverged'; artifacts: readonly string[] }>;
}

class AdReplayEngine {
  async prepare(sourcePath: string): Promise<PreparedAdReplay> {
    return {
      digest: `ad:${sourcePath}`,
      actions: [
        { kind: 'open', app: 'demo' },
        { kind: 'click', selector: 'text="Continue"' },
        { kind: 'verify', selector: 'text="Welcome"' },
      ],
    };
  }

  async execute(
    prepared: PreparedAdReplay,
    runtime: AdReplayRuntime,
    signal: AbortSignal,
  ): Promise<ProgramResult> {
    for (const [index, action] of prepared.actions.entries()) {
      const result = await runtime.executeStep(action, signal);
      if (result.outcome === 'diverged') {
        return { outcome: 'diverged', step: index + 1, artifacts: result.artifacts };
      }
    }
    return { outcome: 'passed', artifacts: ['ad-trace.ndjson'] };
  }
}

type MaestroCommand =
  | { kind: 'launchApp'; appId: string }
  | { kind: 'tapOn'; text: string }
  | { kind: 'assertVisible'; text: string };

type PreparedMaestroFlow = {
  readonly digest: string;
  readonly commands: readonly MaestroCommand[];
};

interface MaestroRuntimePort {
  execute(command: MaestroCommand, signal: AbortSignal): Promise<void>;
  observe(text: string, signal: AbortSignal): Promise<boolean>;
}

class MaestroEngine {
  async prepare(sourcePath: string): Promise<PreparedMaestroFlow> {
    return {
      digest: `maestro:${sourcePath}`,
      commands: [
        { kind: 'launchApp', appId: 'demo' },
        { kind: 'tapOn', text: 'Continue' },
        { kind: 'assertVisible', text: 'Welcome' },
      ],
    };
  }

  async execute(
    prepared: PreparedMaestroFlow,
    runtime: MaestroRuntimePort,
    signal: AbortSignal,
  ): Promise<ProgramResult> {
    for (const command of prepared.commands) {
      const failure = await executeMaestroCommand(command, runtime, signal);
      if (failure) return failure;
    }
    return { outcome: 'passed', artifacts: ['maestro-trace.ndjson'] };
  }
}

async function executeMaestroCommand(
  command: MaestroCommand,
  runtime: MaestroRuntimePort,
  signal: AbortSignal,
): Promise<ProgramResult | undefined> {
  if (command.kind === 'assertVisible') {
    const visible = await runtime.observe(command.text, signal);
    if (!visible) {
      return {
        outcome: 'failed',
        code: 'MAESTRO_ASSERTION_FAILED',
        artifacts: ['maestro-failure.png'],
      };
    }
  }
  await runtime.execute(command, signal);
}

function createExecutors(trace: {
  ad: string[];
  maestro: string[];
}): ReadonlyMap<ProgramFormat, TestProgramExecutor> {
  const adEngine = new AdReplayEngine();
  const maestroEngine = new MaestroEngine();
  return new Map([
    [
      'ad',
      {
        async inspect(sourcePath) {
          return { format: 'ad', sourcePath, caseNames: ['native checkout'] };
        },
        async execute(sourcePath, mode, signal) {
          const prepared = await adEngine.prepare(sourcePath);
          return await adEngine.execute(
            prepared,
            {
              async executeStep(action) {
                trace.ad.push(`execute:${action.kind}`);
                return mode === 'fail' && action.kind === 'click'
                  ? { outcome: 'diverged', artifacts: ['ad-divergence.json'] }
                  : { outcome: 'completed' };
              },
            },
            signal,
          );
        },
      },
    ],
    [
      'maestro',
      {
        async inspect(sourcePath) {
          return { format: 'maestro', sourcePath, caseNames: ['maestro checkout'] };
        },
        async execute(sourcePath, mode, signal) {
          const prepared = await maestroEngine.prepare(sourcePath);
          return await maestroEngine.execute(
            prepared,
            {
              async execute(command) {
                trace.maestro.push(`execute:${command.kind}`);
              },
              async observe(text) {
                trace.maestro.push(`observe:${text}`);
                return mode === 'pass';
              },
            },
            signal,
          );
        },
      },
    ],
  ] satisfies ReadonlyArray<readonly [ProgramFormat, TestProgramExecutor]>);
}

async function runCase(
  executors: ReadonlyMap<ProgramFormat, TestProgramExecutor>,
  format: ProgramFormat,
  mode: RunMode,
): Promise<{ manifest: ProgramManifest; result: ProgramResult }> {
  const executor = executors.get(format);
  assert.ok(executor);
  const sourcePath = format === 'ad' ? 'checkout.ad' : 'checkout.yaml';
  const manifest = await executor.inspect(sourcePath);
  const result = await executor.execute(sourcePath, mode, new AbortController().signal);
  return { manifest, result };
}

const trace = { ad: [] as string[], maestro: [] as string[] };
const executors = createExecutors(trace);
const adPassed = await runCase(executors, 'ad', 'pass');
const adDiverged = await runCase(executors, 'ad', 'fail');
const maestroPassed = await runCase(executors, 'maestro', 'pass');
const maestroFailed = await runCase(executors, 'maestro', 'fail');

assert.equal(adPassed.result.outcome, 'passed');
assert.equal(adDiverged.result.outcome, 'diverged');
assert.equal(maestroPassed.result.outcome, 'passed');
assert.equal(maestroFailed.result.outcome, 'failed');
assert.deepEqual(trace.ad, [
  'execute:open',
  'execute:click',
  'execute:verify',
  'execute:open',
  'execute:click',
]);
assert.deepEqual(trace.maestro, [
  'execute:launchApp',
  'execute:tapOn',
  'observe:Welcome',
  'execute:assertVisible',
  'execute:launchApp',
  'execute:tapOn',
  'observe:Welcome',
]);

process.stdout.write(
  `${JSON.stringify(
    {
      question: 'Can replay-test use one small interface without a shared replay VM?',
      result: 'yes',
      schedulerSurface: ['inspect', 'execute'],
      nativeEngineSurface: ['prepare', 'execute'],
      independentRuntimeEvidence: trace,
    },
    null,
    2,
  )}\n`,
);
