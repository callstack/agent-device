import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mkdtempForTest } from '../../src/__tests__/test-utils/tmp-dir.ts';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import {
  assertCoverageClassificationSummaryWiredToManifest,
  assertLiveCoverageMatchesEvidence,
} from './support/coverage-classification.ts';
import {
  WEB_COVERAGE_GAP_ISSUE,
  WEB_PLATFORM_COVERAGE,
  WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
  WEB_SMOKE_EVIDENCE,
  WEB_SMOKE_TEST_NAME,
  liveCommandsForWebSmoke,
} from './web-e2e/coverage.ts';
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
      assert.equal(
        entry.trackingIssue,
        WEB_COVERAGE_GAP_ISSUE,
        `${command} has the wrong gap issue`,
      );
    }
  }
});

test('web coverage report counts every manifest classification', () => {
  assertCoverageClassificationSummaryWiredToManifest(
    'web',
    WEB_PLATFORM_COVERAGE,
    WEB_PLATFORM_COVERAGE_CLASSIFICATION_SUMMARY,
    publicCommands,
  );
});

// The manifest says which commands are live; the scenario says which ones it runs. Read together
// they close the live bucket from both sides, which a count of either cannot: a command the scenario
// runs but the manifest does not claim, or a claim the scenario stopped honouring, fails here and
// names itself.
test('web live claims are exactly the commands the smoke scenario invokes', () => {
  const smokeSource = fs.readFileSync(path.resolve(WEB_SMOKE_EVIDENCE.path), 'utf8');
  assert.ok(smokeSource.includes(WEB_SMOKE_TEST_NAME));
  assertLiveCoverageMatchesEvidence(
    'web',
    WEB_PLATFORM_COVERAGE,
    invokedWebSmokeCommands(smokeSource),
  );
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

// #1900 closed 14 of the 15 known-gap rows this manifest originally carried (see the comment
// above `WEB_PLATFORM_COVERAGE`); `test` stays a known gap because its only candidate evidence
// proves the command CANNOT be targeted at web, not that it works. This is the planted-red proof
// that no other row can silently regress back to 'known-gap', and that `test`'s stays pinned to
// the one tracking issue.
test('web known gaps use one grouped tracking issue', () => {
  const gapIssues = new Set(
    Object.values(WEB_PLATFORM_COVERAGE)
      .filter((entry) => entry.level === 'known-gap')
      .map((entry) => entry.trackingIssue),
  );
  const gapCommands = Object.entries(WEB_PLATFORM_COVERAGE)
    .filter(([, entry]) => entry.level === 'known-gap')
    .map(([command]) => command);
  assert.deepEqual(gapCommands, ['test']);
  assert.deepEqual([...gapIssues], [WEB_COVERAGE_GAP_ISSUE]);
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

/** Every catalog command the smoke scenario passes as an argv head, read off the scenario source. */
function invokedWebSmokeCommands(smokeSource: string): string[] {
  const catalogCommands: ReadonlySet<string> = new Set(publicCommands);
  const invoked = new Set<string>();
  for (const [, candidate] of smokeSource.matchAll(/\[\s*'([a-z][a-z-]*)'/g)) {
    if (candidate !== undefined && catalogCommands.has(candidate)) {
      invoked.add(candidate);
    }
  }
  return [...invoked].sort();
}

function readCoverageReport(
  artifactDir: string,
  steps: readonly { command: string; status: number }[],
) {
  const reportPath = writeCoverageReport(artifactDir, steps);
  return fs.readFileSync(reportPath, 'utf8');
}
