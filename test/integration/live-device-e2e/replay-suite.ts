import assert from 'node:assert/strict';
import path from 'node:path';

import { assertNonEmptyFile } from './assertions.ts';
import { readReplayCommands, replaySuiteHostTimeoutMs } from './replay-evidence.ts';

/**
 * The live `test`-suite harness, shared by the iOS and Android journeys (#1478 P3).
 *
 * Both platforms invoked the public `test` command and then re-derived the same value-contract
 * assertions by hand: suite totals, per-script status, replay counts, and non-empty JUnit. Those
 * are claims about the published suite result, identical on every platform, and they drifted
 * apart in small ways — one iterated with `readReplayCommands` inline, the other cast
 * `data.tests` at the call site.
 *
 * This owns exactly that boundary: invocation, JUnit validation, per-script status, and replay
 * counts. Everything a platform actually differs on stays with the caller — which scripts run,
 * the retry policy, which commands each script is expected to exercise, and the behavioral
 * claims recorded as evidence. It takes the caller's `runStep` rather than binding a context
 * type, so it is not a platform-configured runner and cannot template a platform's journey.
 */

type LiveSuiteStepResult = {
  json?: { data?: Record<string, unknown> } | undefined;
};

type LiveSuiteRunStep<TContext> = (
  context: TContext,
  step: string,
  args: string[],
  stepOptions?: { timeoutMs?: number },
) => Promise<LiveSuiteStepResult>;

type LiveSuiteTestEntry = {
  file?: unknown;
  status?: unknown;
  replayed?: unknown;
};

export type LiveReplaySuiteRun = {
  /** The raw step result, for platform-specific assertions the shared contract does not cover. */
  suite: LiveSuiteStepResult;
  junitPath: string;
  /** Commands read from each script, keyed by resolved path, so callers need not re-read them. */
  commandsByScript: ReadonlyMap<string, readonly string[]>;
};

export async function runLiveReplayTestSuite<TContext extends { artifactDir: string }>(params: {
  context: TContext;
  runStep: LiveSuiteRunStep<TContext>;
  step: string;
  scripts: readonly string[];
  /** Omitted or 0 runs without `--retries`, which is itself a platform claim worth keeping. */
  retries?: number;
  artifactName?: string;
}): Promise<LiveReplaySuiteRun> {
  const { context, runStep, step, scripts, retries = 0, artifactName = 'fixture-replays' } = params;
  const resolvedScripts = scripts.map((script) => path.resolve(script));
  const junitPath = path.join(context.artifactDir, `${artifactName}.junit.xml`);
  const suiteArtifacts = path.join(context.artifactDir, artifactName);

  const suite = await runStep(
    context,
    step,
    [
      'test',
      ...resolvedScripts,
      ...(retries > 0 ? ['--retries', String(retries)] : []),
      '--artifacts-dir',
      suiteArtifacts,
      '--report-junit',
      junitPath,
    ],
    { timeoutMs: replaySuiteHostTimeoutMs(resolvedScripts, retries) },
  );

  const evidence = () => JSON.stringify(suite.json);
  assert.equal(suite.json?.data?.failed, 0, evidence());
  assert.equal(suite.json?.data?.passed, resolvedScripts.length, evidence());

  const tests = Array.isArray(suite.json?.data?.tests)
    ? (suite.json.data.tests as LiveSuiteTestEntry[])
    : [];
  const commandsByScript = new Map<string, readonly string[]>();
  for (const script of resolvedScripts) {
    const result = tests.find((entry) => path.resolve(String(entry.file)) === script);
    const commands = readReplayCommands(script);
    commandsByScript.set(script, commands);
    assert.equal(result?.status, 'passed', evidence());
    assert.equal(result?.replayed, commands.length, evidence());
  }

  assertNonEmptyFile(junitPath, 'fixture JUnit');
  return { suite, junitPath, commandsByScript };
}
