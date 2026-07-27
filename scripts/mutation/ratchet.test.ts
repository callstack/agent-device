import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ALL_MODULE_IDS } from './modules.ts';
import { renderReport } from './report.ts';
import {
  applyRun,
  BASELINE_SCHEMA_VERSION,
  DEFAULT_REQUIRED_STABLE_RUNS,
  emptyBaseline,
  evaluateRatchet,
  type Baseline,
  type ModuleBaseline,
  type Provenance,
} from './ratchet.ts';
import { summarizeReport, type StrykerReport } from './score.ts';

const PROVENANCE: Provenance = { strykerVersion: '9.6.1', configHash: 'sha256:abcdef123456' };
const NOW = '2026-07-27T00:00:00.000Z';

function mutants(statuses: readonly string[]): StrykerReport {
  return {
    files: {
      'src/kernel/errors.ts': {
        mutants: statuses.map((status, index) => ({
          status,
          mutatorName: 'ConditionalExpression',
          location: { start: { line: index + 1 } },
        })),
      },
    },
  };
}

function baselineWith(entry: Partial<ModuleBaseline>): Baseline {
  return {
    ...emptyBaseline(),
    modules: {
      'kernel-errors': {
        score: 75,
        killed: 3,
        survived: 1,
        total: 4,
        strykerVersion: PROVENANCE.strykerVersion,
        configHash: PROVENANCE.configHash,
        updatedAt: NOW,
        ...entry,
      },
    },
  };
}

test('scores count timeouts as killed and uncovered mutants as survived', () => {
  const [score] = summarizeReport(mutants(['Killed', 'Timeout', 'Survived', 'NoCoverage']), [
    'kernel-errors',
  ]);
  assert.deepEqual(
    { score: score?.score, killed: score?.killed, survived: score?.survived, total: score?.total },
    { score: 50, killed: 2, survived: 2, total: 4 },
  );
});

test('statuses outside the score (Ignored, CompileError) leave the denominator', () => {
  const [score] = summarizeReport(mutants(['Killed', 'Ignored', 'CompileError']), [
    'kernel-errors',
  ]);
  assert.equal(score?.total, 1);
  assert.equal(score?.score, 100);
});

test('a lowered score is a regression, and gating makes it fail with its survivors', () => {
  const baseline = { ...baselineWith({ score: 100 }), stableRuns: 2, gating: true };
  const scores = summarizeReport(mutants(['Killed', 'Survived']), ['kernel-errors']);
  const result = evaluateRatchet(scores, baseline, PROVENANCE);

  assert.equal(result.failed, true);
  assert.deepEqual(
    result.regressions.map((verdict) => verdict.module),
    ['kernel-errors'],
  );
  assert.match(result.regressions[0]?.detail ?? '', /fell 100% -> 50%/);

  const markdown = renderReport(result, baseline, PROVENANCE);
  assert.match(markdown, /Surviving mutants:/);
  assert.match(markdown, /`src\/kernel\/errors\.ts:2` ConditionalExpression/);
  assert.match(markdown, /scores may only rise/);
});

test('a lowered score is reported but does not fail while the lane is non-gating', () => {
  const scores = summarizeReport(mutants(['Killed', 'Survived']), ['kernel-errors']);
  const baseline = baselineWith({ score: 100 });
  const result = evaluateRatchet(scores, baseline, PROVENANCE);

  assert.equal(result.regressions.length, 1);
  assert.equal(result.failed, false);
  assert.match(renderReport(result, baseline, PROVENANCE), /still non-gating/);
});

test('a regression never rewrites the baseline high-water mark', () => {
  const baseline = baselineWith({ score: 100 });
  const scores = summarizeReport(mutants(['Killed', 'Survived']), ['kernel-errors']);
  const next = applyRun(baseline, scores, evaluateRatchet(scores, baseline, PROVENANCE), {
    provenance: PROVENANCE,
    now: NOW,
    countsTowardGraduation: true,
  });
  assert.equal(next.modules['kernel-errors']?.score, 100);
  assert.equal(next.stableRuns, 0);
});

test('a risen score is recorded with its provenance', () => {
  const baseline = baselineWith({ score: 50 });
  const scores = summarizeReport(mutants(['Killed', 'Killed']), ['kernel-errors']);
  const result = evaluateRatchet(scores, baseline, PROVENANCE);
  assert.equal(result.verdicts[0]?.status, 'improved');

  const next = applyRun(baseline, scores, result, {
    provenance: PROVENANCE,
    now: NOW,
    countsTowardGraduation: true,
  });
  assert.deepEqual(next.modules['kernel-errors'], {
    score: 100,
    killed: 2,
    survived: 0,
    total: 2,
    strykerVersion: PROVENANCE.strykerVersion,
    configHash: PROVENANCE.configHash,
    updatedAt: NOW,
  });
});

test('gating graduates after the required consecutive stable full sweeps', () => {
  const scores = summarizeReport(mutants(['Killed', 'Killed']), ['kernel-errors']);
  let baseline = baselineWith({ score: 100 });
  assert.equal(baseline.gating, false);

  for (let run = 1; run <= baseline.requiredStableRuns; run += 1) {
    const result = evaluateRatchet(scores, baseline, PROVENANCE);
    baseline = applyRun(baseline, scores, result, {
      provenance: PROVENANCE,
      now: NOW,
      countsTowardGraduation: true,
    });
    assert.equal(baseline.stableRuns, run);
  }
  assert.equal(baseline.gating, true);

  // A later regression resets graduation, so gating has to be re-earned.
  const dropped = summarizeReport(mutants(['Killed', 'Survived']), ['kernel-errors']);
  const regressed = evaluateRatchet(dropped, baseline, PROVENANCE);
  assert.equal(regressed.failed, true);
  const after = applyRun(baseline, dropped, regressed, {
    provenance: PROVENANCE,
    now: NOW,
    countsTowardGraduation: true,
  });
  assert.equal(after.stableRuns, 0);
  assert.equal(after.gating, false);
});

test('an affected PR run never advances graduation', () => {
  const scores = summarizeReport(mutants(['Killed', 'Killed']), ['kernel-errors']);
  const baseline = baselineWith({ score: 100 });
  const next = applyRun(baseline, scores, evaluateRatchet(scores, baseline, PROVENANCE), {
    provenance: PROVENANCE,
    now: NOW,
    countsTowardGraduation: false,
  });
  assert.equal(next.stableRuns, 0);
});

test('a tool or config change is provenance drift, not a test-strength regression', () => {
  const scores = summarizeReport(mutants(['Killed', 'Survived']), ['kernel-errors']);
  for (const drift of [{ strykerVersion: '9.5.0' }, { configHash: 'sha256:000000000000' }]) {
    const baseline = { ...baselineWith({ score: 100, ...drift }), stableRuns: 2, gating: true };
    const result = evaluateRatchet(scores, baseline, PROVENANCE);
    assert.equal(result.regressions.length, 0);
    assert.equal(result.failed, false);
    assert.equal(result.comparable, false);
    assert.match(result.drifted[0]?.detail ?? '', /not attributable to test strength/);

    // Drift rebases onto the new tool/config and costs the graduation streak.
    const next = applyRun(baseline, scores, result, {
      provenance: PROVENANCE,
      now: NOW,
      countsTowardGraduation: true,
    });
    assert.equal(next.modules['kernel-errors']?.score, 50);
    assert.equal(next.modules['kernel-errors']?.configHash, PROVENANCE.configHash);
    assert.equal(next.stableRuns, 0);
  }
});

test('a module with no baseline yet is new, recorded, and blocks graduation', () => {
  const scores = summarizeReport(mutants(['Killed', 'Survived']), ['kernel-errors']);
  const baseline = emptyBaseline();
  const result = evaluateRatchet(scores, baseline, PROVENANCE);
  assert.equal(result.verdicts[0]?.status, 'new');
  assert.equal(result.comparable, false);

  const next = applyRun(baseline, scores, result, {
    provenance: PROVENANCE,
    now: NOW,
    countsTowardGraduation: true,
  });
  assert.equal(next.modules['kernel-errors']?.score, 50);
  assert.equal(next.stableRuns, 0);
});

test('the report names the fix command and the graduation state', () => {
  const scores = summarizeReport(mutants(['Killed', 'Killed']), ['kernel-errors']);
  const baseline = { ...baselineWith({ score: 100 }), stableRuns: 1 };
  const markdown = renderReport(
    evaluateRatchet(scores, baseline, PROVENANCE),
    baseline,
    PROVENANCE,
  );
  assert.match(markdown, /gating \*\*off\*\* \(1\/2 stable weekly runs\)/);
  assert.match(markdown, /Stryker `9\.6\.1` · config `sha256:abcdef123456`/);
});

test('the committed baseline is the shape the lane graduates from', () => {
  const baseline = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../../mutation-baselines/decision-kernels.json'),
      'utf8',
    ),
  ) as Baseline;
  assert.equal(baseline.schemaVersion, BASELINE_SCHEMA_VERSION);
  // Issue #1415's N: gating is earned by two consecutive stable weekly sweeps.
  assert.equal(baseline.requiredStableRuns, DEFAULT_REQUIRED_STABLE_RUNS);
  assert.deepEqual(Object.keys(baseline.modules), [...ALL_MODULE_IDS]);
  for (const [id, module] of Object.entries(baseline.modules)) {
    assert.ok(module.total > 0, `${id} has no mutants`);
    assert.ok(module.strykerVersion.length > 0, `${id} has no Stryker version`);
    assert.match(module.configHash, /^sha256:[0-9a-f]{12}$/);
  }
});
