import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import type { CliJsonResult } from './cli-json.ts';
import { createLiveDeviceContext, createLiveDeviceHarness } from './live-device-e2e/runtime.ts';

function fixture(options: { captureThrows?: boolean; deviceEvidence?: string } = {}) {
  const context = createLiveDeviceContext<string>({
    artifactRoot: mkdtempForTestSync('scenario-failure-evidence-'),
    session: 'owned-fixture',
  });
  const calls: string[][] = [];
  let reports = 0;
  const harness = createLiveDeviceHarness<typeof context, string>({
    behaviorsForScenario: () => [],
    commandsForScenario: () => [],
    commonFlags: (current, args) => [...args, '--session', current.session, '--json'],
    runCli: async (args): Promise<CliJsonResult> => {
      calls.push(args);
      if (args[0] === 'screenshot' || args[0] === 'snapshot') {
        if (options.captureThrows) throw new Error('capture unavailable');
        if (args[0] === 'screenshot') fs.writeFileSync(args[1]!, 'fixture-png');
        return { status: 0, stdout: '', stderr: '', json: { success: true, data: { nodes: [] } } };
      }
      return { status: 1, stdout: '', stderr: '', json: { success: false } };
    },
    ...(options.deviceEvidence === undefined
      ? {}
      : { deviceEvidence: async () => options.deviceEvidence }),
    writeCoverageReport: () => {
      reports += 1;
    },
  });
  return { context, harness, calls, reports: () => reports };
}

test('a scenario assertion after allowed misses captures evidence before caller cleanup', async () => {
  const { context, harness, calls, reports } = fixture();
  const failure = new assert.AssertionError({ message: 'canary never became visible' });
  await assert.rejects(
    harness.runScenario(context, {
      id: 'visibility',
      run: async () => {
        await harness.runStep(context, 'probe', ['is', 'visible', 'id="canary"'], {
          allowFailure: true,
        });
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );

  assert.deepEqual(
    calls.map((args) => args[0]),
    ['is', 'screenshot', 'snapshot'],
  );
  for (const args of calls)
    assert.deepEqual(args.slice(-3), ['--session', 'owned-fixture', '--json']);
  assert.ok(fs.existsSync(path.join(context.artifactDir, 'failed-step-1.png')));
  assert.ok(fs.existsSync(path.join(context.artifactDir, 'failed-step-1-snapshot.json')));
  const report = fs.readFileSync(path.join(context.artifactDir, 'failed-step.txt'), 'utf8');
  assert.match(report, /scenario: visibility/);
  assert.match(report, /canary never became visible/);
  assert.match(report, /failed-step-1-snapshot.json/);
  assert.deepEqual(context.completedScenarios, []);
  assert.equal(reports(), 1);
});

test('a scenario assertion before any command also captures evidence', async () => {
  const { context, harness, calls } = fixture();
  const failure = new Error('fixture assertion');
  await assert.rejects(
    harness.runScenario(context, {
      id: 'assertion',
      run: async () => {
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['screenshot', 'snapshot'],
  );
  assert.ok(fs.existsSync(path.join(context.artifactDir, 'failed-step-0-snapshot.json')));
});

test('scenario failure includes platform-owned device evidence', async () => {
  const { context, harness } = fixture({ deviceEvidence: 'fixture process exited' });
  const failure = new Error('missing canary');
  await assert.rejects(
    harness.runScenario(context, {
      id: 'device-facts',
      run: async () => {
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
  const devicePath = path.join(context.artifactDir, 'failed-step-0-device.txt');
  assert.equal(fs.readFileSync(devicePath, 'utf8'), 'fixture process exited');
  assert.match(
    fs.readFileSync(path.join(context.artifactDir, 'failed-step.txt'), 'utf8'),
    /failed-step-0-device\.txt/,
  );
});

test('an already captured command failure is not captured again by its scenario', async () => {
  const { context, harness, calls } = fixture();
  await assert.rejects(
    harness.runScenario(context, {
      id: 'command',
      run: async () => {
        await harness.runStep(context, 'read canary', ['get', 'text', 'id="canary"']);
      },
    }),
    /step: read canary/,
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['get', 'screenshot', 'snapshot'],
  );
  assert.match(
    fs.readFileSync(path.join(context.artifactDir, 'failed-step.txt'), 'utf8'),
    /step: read canary/,
  );
});

test('failed capture preserves the scenario error and still writes coverage', async () => {
  const { context, harness, calls, reports } = fixture({ captureThrows: true });
  const failure = new Error('original assertion');
  await assert.rejects(
    harness.runScenario(context, {
      id: 'capture-failure',
      run: async () => {
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(
    calls.map((args) => args[0]),
    ['screenshot', 'snapshot'],
  );
  assert.equal(reports(), 1);
  assert.match(
    fs.readFileSync(path.join(context.artifactDir, 'failed-step.txt'), 'utf8'),
    /capture failed/,
  );
});

test('a successful scenario has no diagnostic capture', async () => {
  const { context, harness, calls, reports } = fixture();
  await harness.runScenario(context, { id: 'success', run: async () => undefined });
  assert.deepEqual(calls, []);
  assert.deepEqual(context.completedScenarios, ['success']);
  assert.equal(reports(), 1);
  assert.equal(fs.existsSync(path.join(context.artifactDir, 'failed-step.txt')), false);
});

// #2491: the lane re-issues one step whose own typed miss says observation was prevented, so a
// single runner restart costs a repeat of the wait instead of the job. The classifier is injected
// so these cases pin the harness mechanism, and `live-step-retry-policy.ts`'s tests pin the
// verdicts the iOS lane feeds it.

function reissueFixture(options: {
  /** Statuses served per issue of the step; the last one repeats. */
  statuses: number[];
}) {
  const context = createLiveDeviceContext<string>({
    artifactRoot: mkdtempForTestSync('step-reissue-'),
    session: 'owned-fixture',
  });
  const calls: string[][] = [];
  let issues = 0;
  const harness = createLiveDeviceHarness<typeof context, string>({
    behaviorsForScenario: () => [],
    commandsForScenario: () => [],
    commonFlags: (_current, args) => [...args, '--json'],
    runCli: async (args): Promise<CliJsonResult> => {
      calls.push(args);
      if (args[0] === 'screenshot' || args[0] === 'snapshot') {
        if (args[0] === 'screenshot') fs.writeFileSync(args[1]!, 'fixture-png');
        return { status: 0, stdout: '', stderr: '', json: { success: true, data: { nodes: [] } } };
      }
      issues += 1;
      const status = options.statuses[Math.min(issues, options.statuses.length) - 1]!;
      return status === 0
        ? { status: 0, stdout: '', stderr: '', json: { success: true } }
        : {
            status: 1,
            stdout: '',
            stderr: '',
            json: { error: { code: 'COMMAND_FAILED', details: { reason: 'wait_stub' } } },
          };
    },
    writeCoverageReport: () => {},
  });
  return { context, harness, calls };
}

test('an observation-prevented miss re-issues the step once and the step passes', async () => {
  let classified = 0;
  const { context, harness, calls } = reissueFixture({ statuses: [1, 0] });
  const result = await harness.runStep(context, 'wait for text', ['wait', 'text', 'Home'], {
    reattemptInfrastructureMiss: () => {
      classified += 1;
      return true;
    },
  });
  assert.equal(result.status, 0);
  assert.equal(classified, 1);
  assert.equal(calls.filter((args) => args[0] === 'wait').length, 2);
  assert.deepEqual(
    context.stepHistory
      .filter((record) => record.commandName === 'wait')
      .map((record) => [record.step, record.status, record.accepted]),
    [
      ['wait for text', 1, false],
      ['wait for text (re-issue after observation-prevented miss)', 0, true],
    ],
  );
});

test('a re-issued miss writes no failure evidence; the final issue owns it', async () => {
  const { context, harness, calls } = reissueFixture({ statuses: [1, 1] });
  await assert.rejects(
    harness.runStep(context, 'wait for text', ['wait', 'text', 'Home'], {
      reattemptInfrastructureMiss: () => true,
    }),
    /re-issue after observation-prevented miss/,
  );
  assert.equal(calls.filter((args) => args[0] === 'wait').length, 2);
  // Evidence capture ran once, for the issue the step is judged on, and its report names that
  // issue rather than the one the policy already accepted to repeat.
  assert.equal(calls.filter((args) => args[0] === 'screenshot').length, 1);
  const report = fs.readFileSync(path.join(context.artifactDir, 'failed-step.txt'), 'utf8');
  assert.match(report, /re-issue after observation-prevented miss/);
});

test('a miss the classifier refuses fails at once with the recorded evidence', async () => {
  const { context, harness, calls } = reissueFixture({ statuses: [1] });
  await assert.rejects(
    harness.runStep(context, 'wait for text', ['wait', 'text', 'Home'], {
      reattemptInfrastructureMiss: () => false,
    }),
    /step: wait for text/,
  );
  assert.equal(calls.filter((args) => args[0] === 'wait').length, 1);
  assert.ok(fs.existsSync(path.join(context.artifactDir, 'failed-step.txt')));
});

test('a successful step never consults the re-attribution classifier', async () => {
  let classified = 0;
  const { context, harness, calls } = reissueFixture({ statuses: [0] });
  await harness.runStep(context, 'wait for text', ['wait', 'text', 'Home'], {
    reattemptInfrastructureMiss: () => {
      classified += 1;
      return true;
    },
  });
  assert.equal(classified, 0);
  assert.equal(calls.filter((args) => args[0] === 'wait').length, 1);
});

test('a step with its own allowFailure policy is issued once even when the classifier would retry', async () => {
  const { context, harness, calls } = reissueFixture({ statuses: [1] });
  const result = await harness.runStep(context, 'probe', ['is', 'visible', 'id="canary"'], {
    allowFailure: true,
    reattemptInfrastructureMiss: () => true,
  });
  assert.equal(result.status, 1);
  assert.equal(calls.filter((args) => args[0] === 'is').length, 1);
});

test('a step with expectFailure is issued once even when the classifier would retry', async () => {
  const { context, harness, calls } = reissueFixture({ statuses: [1] });
  await harness.runStep(context, 'refusal', ['capabilities', '--x'], {
    expectFailure: true,
    reattemptInfrastructureMiss: () => true,
  });
  assert.equal(calls.filter((args) => args[0] === 'capabilities').length, 1);
});

test('unwritable artifact output cannot replace the scenario failure', async () => {
  const { context, harness, reports } = fixture();
  fs.renameSync(context.artifactDir, `${context.artifactDir}-moved`);
  const failure = new Error('original failure before artifact I/O');
  await assert.rejects(
    harness.runScenario(context, {
      id: 'write-failure',
      run: async () => {
        throw failure;
      },
    }),
    (error: unknown) => error === failure,
  );
  assert.equal(reports(), 1);
});
