import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { WEB_DESKTOP_DEVICE } from '../../src/__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { isCommandSupportedOnDevice } from '../../src/core/capabilities.ts';
import {
  WEB_PLATFORM_COVERAGE,
  WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  WEB_SMOKE_EVIDENCE,
  WEB_SMOKE_TEST_NAME,
  liveCommandsForWebSmoke,
} from './web-e2e/coverage-manifest.ts';
import { runCleanupWithCoverageReport, writeCoverageReport } from './web-e2e/coverage-report.ts';

const publicCommands = Object.values(PUBLIC_COMMANDS).sort();

test('web coverage exhaustively classifies the public catalog', () => {
  assert.deepEqual(Object.keys(WEB_PLATFORM_COVERAGE).sort(), publicCommands);

  for (const command of publicCommands) {
    const entry = WEB_PLATFORM_COVERAGE[command];
    assert.ok(entry.assertion.trim().length > 0, `${command} needs an observable assertion`);
    if (entry.level === 'live' || entry.level === 'command-contract') {
      assert.ok(entry.owner.path.trim().length > 0, `${command} needs an evidence path`);
      assert.ok(entry.owner.test.trim().length > 0, `${command} needs named evidence`);
    }
    if (entry.level === 'known-gap') {
      assert.ok(
        Number.isInteger(entry.trackingIssue) && entry.trackingIssue > 0,
        `${command} needs a valid gap tracking issue`,
      );
    }
  }
});

test('web coverage report has the expected classification counts', () => {
  assert.deepEqual(WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY, {
    capabilityDenial: 7,
    contract: 35,
    gap: 0,
    live: 12,
    total: 54,
  });
});

test('web live claims reference commands in the existing smoke scenario', () => {
  const smokeSource = fs.readFileSync(path.resolve(WEB_SMOKE_EVIDENCE.path), 'utf8');
  assert.ok(smokeSource.includes(WEB_SMOKE_TEST_NAME));

  const liveCommands = liveCommandsForWebSmoke();
  assert.equal(liveCommands.length, 12);
  for (const command of liveCommands) {
    assert.equal(
      smokeSource.includes(`'${command}',`),
      true,
      `${command} is not invoked by ${WEB_SMOKE_EVIDENCE.path}`,
    );
  }
});

test('web contract claims name existing executable evidence', () => {
  for (const [command, entry] of Object.entries(WEB_PLATFORM_COVERAGE)) {
    if (entry.level !== 'command-contract') continue;
    const evidencePath = path.resolve(entry.owner.path);
    assert.equal(fs.existsSync(evidencePath), true, `${command} owner does not exist`);
    assert.equal(
      fs.readFileSync(evidencePath, 'utf8').includes(entry.owner.test),
      true,
      `${command} owner does not contain named evidence`,
    );
  }
});

test('web capability denials match the mechanical capability matrix', () => {
  const deniedByCapabilities = publicCommands.filter(
    (command) => !isCommandSupportedOnDevice(command, WEB_DESKTOP_DEVICE),
  );
  const deniedByManifest = Object.entries(WEB_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'capability-denial')
    .map(([command]) => command)
    .sort();

  assert.deepEqual(deniedByManifest, deniedByCapabilities);
});

// #1900 closed every known-gap row this manifest carried (see the comment above
// `WEB_PLATFORM_COVERAGE`): each now cites a runtime-owned denial fact or a new test proving the
// command's existing code path already runs for a web-backed session. This is the planted-red
// proof that a future row can't silently regress back to 'known-gap' without failing here.
test('web has no known-gap rows left after #1900', () => {
  const gaps = Object.entries(WEB_PLATFORM_COVERAGE).filter(
    ([, entry]) => entry.level === 'known-gap',
  );
  assert.deepEqual(gaps, []);
});

test('web coverage report persists the manifest rollup and live command list', async () => {
  const artifactDir = await mkdtempForTest('agent-device-web-coverage-');
  const steps = [{ command: 'agent-device open http://127.0.0.1 --platform web', status: 0 }];
  const report = JSON.parse(readCoverageReport(artifactDir, steps)) as {
    classificationSummary: typeof WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY;
    liveCommands: string[];
    steps: typeof steps;
  };

  assert.deepEqual(report.classificationSummary, WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY);
  assert.deepEqual(report.liveCommands.sort(), liveCommandsForWebSmoke().sort());
  assert.deepEqual(report.steps, steps);
});

test('web coverage report survives a failed close cleanup', async () => {
  const artifactDir = await mkdtempForTest('agent-device-web-close-failure-');
  const steps = [{ command: 'agent-device close --platform web', status: 1 }];
  const closeError = new Error('close failed');

  await assert.rejects(
    runCleanupWithCoverageReport(artifactDir, steps, async () => {
      throw closeError;
    }),
    (error) => error === closeError,
  );

  const report = JSON.parse(
    fs.readFileSync(path.join(artifactDir, 'coverage-report.json'), 'utf8'),
  ) as { steps: typeof steps };
  assert.deepEqual(report.steps, steps);
});

test('web cleanup error is preserved when report writing also fails', async () => {
  const artifactDir = await mkdtempForTest('agent-device-web-report-failure-');
  const cleanupError = new Error('close failed');

  await assert.rejects(
    runCleanupWithCoverageReport(path.join(artifactDir, 'missing-directory'), [], async () => {
      throw cleanupError;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], cleanupError);
      assert.ok(error.errors[1] instanceof Error);
      return true;
    },
  );
});

function readCoverageReport(
  artifactDir: string,
  steps: readonly { command: string; status: number }[],
) {
  const reportPath = writeCoverageReport(artifactDir, steps);
  return fs.readFileSync(reportPath, 'utf8');
}
