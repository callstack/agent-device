import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { CliJsonResult } from './cli-json.ts';
import { collectFailedStepEvidence } from './live-device-e2e/failed-step-evidence.ts';
import { createLiveDeviceContext, createLiveDeviceHarness } from './live-device-e2e/runtime.ts';

function fakeCli(artifacts: { screenshot?: boolean; snapshot?: boolean } = {}) {
  const calls: string[][] = [];
  const runCli = async (args: string[]): Promise<CliJsonResult> => {
    calls.push(args);
    if (args[0] === 'screenshot') {
      if (artifacts.screenshot === false) return { status: 1, stdout: '', stderr: 'no screen' };
      fs.writeFileSync(args[1]!, 'png');
      return { status: 0, stdout: '', stderr: '', json: { success: true } };
    }
    if (args[0] === 'snapshot') {
      if (artifacts.snapshot === false) return { status: 1, stdout: '', stderr: 'no tree' };
      return { status: 0, stdout: '', stderr: '', json: { success: true, data: { nodes: [] } } };
    }
    return { status: 1, stdout: '', stderr: 'step failed', json: { success: false } };
  };
  return { calls, runCli };
}

function tempStem(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-step-evidence-'));
  return path.join(dir, 'failed-step-3');
}

test('device facts land in their own file next to the screenshot and snapshot', async () => {
  const stem = tempStem();
  const cli = fakeCli();

  const evidence = await collectFailedStepEvidence({
    stem,
    runCli: cli.runCli,
    deviceEvidence: async () => '## user_rotation\n1\n',
  });

  assert.deepEqual(evidence, {
    screenshotPath: `${stem}.png`,
    snapshotPath: `${stem}-snapshot.json`,
    devicePath: `${stem}-device.txt`,
  });
  assert.equal(fs.readFileSync(`${stem}-device.txt`, 'utf8'), '## user_rotation\n1\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(`${stem}-snapshot.json`, 'utf8')), {
    success: true,
    data: { nodes: [] },
  });
  assert.deepEqual(
    cli.calls.map((args) => args[0]),
    ['screenshot', 'snapshot'],
  );
});

test('a device hook that throws or returns nothing still leaves the CLI evidence in place', async () => {
  for (const deviceEvidence of [
    async () => {
      throw new Error('adb unavailable');
    },
    async () => undefined,
  ]) {
    const stem = tempStem();
    const evidence = await collectFailedStepEvidence({
      stem,
      runCli: fakeCli().runCli,
      deviceEvidence,
    });

    assert.deepEqual(evidence, {
      screenshotPath: `${stem}.png`,
      snapshotPath: `${stem}-snapshot.json`,
    });
    assert.equal(fs.existsSync(`${stem}-device.txt`), false);
  }
});

test('a device hook that never answers is bounded and never delays the CLI evidence', async () => {
  const stem = tempStem();
  const startedAt = Date.now();

  const evidence = await collectFailedStepEvidence({
    stem,
    runCli: fakeCli().runCli,
    deviceEvidence: () => new Promise<string>(() => undefined),
    deviceEvidenceTimeoutMs: 50,
  });

  assert.deepEqual(evidence, {
    screenshotPath: `${stem}.png`,
    snapshotPath: `${stem}-snapshot.json`,
  });
  assert.ok(Date.now() - startedAt < 1_000);
});

test('a failed step names its evidence files, including the device file, in failed-step.txt', async () => {
  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'failed-step-harness-'));
  const cli = fakeCli();
  const harness = createLiveDeviceHarness<
    ReturnType<typeof createLiveDeviceContext<string>>,
    string
  >({
    behaviorsForScenario: () => [],
    commandsForScenario: () => [],
    commonFlags: (_context, args) => [...args, '--json'],
    runCli: cli.runCli,
    deviceEvidence: async () => 'accelerometer_rotation=1\n',
    writeCoverageReport: () => undefined,
  });
  const context = createLiveDeviceContext<string>({ artifactRoot, session: 'evidence' });

  await assert.rejects(
    harness.runStep(context, 'read the canary', ['get', 'text', 'id="canary"']),
    (error: Error) => {
      assert.match(error.message, /step: read the canary/);
      assert.match(error.message, /device: .*failed-step-1-device\.txt/);
      assert.match(error.message, /screenshot: .*failed-step-1\.png/);
      assert.match(error.message, /snapshot: .*failed-step-1-snapshot\.json/);
      return true;
    },
  );

  const report = fs.readFileSync(path.join(context.artifactDir, 'failed-step.txt'), 'utf8');
  assert.match(report, /device: .*failed-step-1-device\.txt/);
  assert.equal(
    fs.readFileSync(path.join(context.artifactDir, 'failed-step-1-device.txt'), 'utf8'),
    'accelerometer_rotation=1\n',
  );
});
