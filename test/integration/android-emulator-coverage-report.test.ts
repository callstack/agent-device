import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { PUBLIC_COMMANDS } from '../../src/command-catalog.ts';
import { ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY } from './android-emulator-e2e/coverage-manifest.ts';
import type { LiveContext } from './android-emulator-e2e/live-harness.ts';
import { writeCoverageReport } from './android-emulator-e2e/live-coverage-report.ts';

test('Android coverage report persists the manifest rollup and executed tier', (t) => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-android-coverage-'));
  t.after(() => fs.rmSync(artifactDir, { force: true, recursive: true }));
  const context: LiveContext = {
    appId: 'com.example.fixture',
    appPath: '/fixture.apk',
    artifactDir,
    behaviorEvidence: {},
    commandEvidence: {
      [PUBLIC_COMMANDS.close]: ['session released'],
    },
    completedScenarios: ['smoke:capture-close'],
    currentScenario: 'smoke:capture-close',
    env: {},
    serial: 'emulator-5554',
    session: 'coverage-report',
    sessionOpen: false,
    startedAtMs: Date.now(),
    stepHistory: [],
    tier: 'full',
    timings: [],
  };

  const report = JSON.parse(fs.readFileSync(writeCoverageReport(context), 'utf8')) as {
    classificationSummary: typeof ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY;
    tier: LiveContext['tier'];
  };

  assert.deepEqual(report.classificationSummary, ANDROID_EMULATOR_COVERAGE_CLASSIFICATION_SUMMARY);
  assert.equal(report.tier, 'full');
});
