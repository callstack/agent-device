import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mkdtempForTestSync } from '../../src/__tests__/test-utils/tmp-dir.ts';
import type { CliJsonResult } from './cli-json.ts';
import { createLiveDeviceContext, createLiveDeviceHarness } from './live-device-e2e/runtime.ts';

function fixture(options: { captureThrows?: boolean } = {}) {
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
