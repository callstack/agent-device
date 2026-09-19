import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BatchRun } from './batches.ts';
import { buildLegibilityReport, formatLegibilitySummary } from './report.ts';
import type { Score } from './score.ts';

const run: BatchRun = {
  answers: new Map(),
  unanswered: new Map([['src/late.ts', { kind: 'request-cap', maxRequests: 3 }]]),
  requests: 3,
  splits: 1,
  usage: { inputTokens: 1_000_000, outputTokens: 50 },
};

const score: Score = {
  headline: {
    n: 40,
    answered: 39,
    unanswered: 1,
    excludedSmallFamilyFiles: 2,
    model: 0.5,
    majority: 0.18,
    neighbourVote: 0.3,
    knn: 0.43,
    spread: {
      best: { family: 'selectors', accuracy: 0.95, n: 20 },
      worst: { family: 'cli', accuracy: 0.15, n: 20 },
      points: 80,
    },
  },
  perFamily: [
    {
      family: 'cli',
      files: 58,
      n: 20,
      answered: 20,
      accuracy: 0.15,
      knn: 0.4,
      delta: -0.25,
      medianConfidence: 0.4,
      modularity: 0.0127,
      outInFlow: 4.8,
      smallSample: false,
    },
    {
      family: 'xml',
      files: 4,
      n: 1,
      answered: 1,
      accuracy: 1,
      knn: 0,
      delta: 1,
      medianConfidence: null,
      modularity: 0,
      outInFlow: null,
      smallSample: true,
    },
  ],
  divergences: [
    {
      id: 'src/daemon/replay/internal/session-replay-x.ts',
      family: 'daemon-server',
      predicted: 'ad-replay',
      p: 0.61,
      viaRename: true,
      subject: 'move replay',
    },
  ],
  files: [],
};

const report = buildLegibilityReport({
  generated: {
    commit: 'abc1234',
    date: '2026-09-19T00:00:00.000Z',
    files: 1726,
    families: 39,
    condition: 'reader (scored)',
    sample: { size: 40, seed: 2677, all: false, ids: ['a'] },
  },
  leak: { files: 40, leaking: [], rate: 0 },
  nameEcho: { files: 40, leaking: ['src/daemon/replay/internal/session-replay-x.ts'], rate: 0.025 },
  leakLimit: 0.01,
  run,
  batchSize: 40,
  maxRequests: 3,
  score,
  ablation: {
    condition: 'name-withheld ablation (not a score)',
    accuracy: 0.375,
    answered: 40,
    requests: 1,
    delta: -0.125,
  },
  leakReferences: [
    { condition: 'leak reference: raw-subject', accuracy: 0.7, answered: 39, requests: 2 },
  ],
});

test('the report carries the declared shape', () => {
  assert.deepEqual(Object.keys(report), [
    'generated',
    'leak',
    'nameEcho',
    'requests',
    'usage',
    'baselines',
    'headline',
    'perFamily',
    'divergences',
    'unanswered',
    'ablation',
    'leakReferences',
    'files',
  ]);
  assert.deepEqual(report.baselines, { majority: 0.18, neighbourVote: 0.3, knn: 0.43, model: 0.5 });
  assert.deepEqual(Object.keys(report.perFamily[0]!), [
    'family',
    'files',
    'n',
    'answered',
    'accuracy',
    'knn',
    'delta',
    'medianConfidence',
    'modularity',
    'outInFlow',
    'smallSample',
  ]);
  assert.deepEqual(Object.keys(report.divergences[0]!), [
    'id',
    'family',
    'predicted',
    'p',
    'viaRename',
    'subject',
  ]);
  assert.deepEqual(report.usage, { inputTokens: 1_000_000, outputTokens: 50, costUsd: 0.042 });
  assert.deepEqual(report.unanswered, [
    { id: 'src/late.ts', reason: { kind: 'request-cap', maxRequests: 3 } },
  ]);
});

test('the text summary prints leak rate, baselines, rows, divergences, splits, cost, and the leak reference as not-the-score', () => {
  const text = formatLegibilitySummary(report);
  for (const needle of [
    "name echo (reader evidence already names the file's own family): 1/40 files (2.50%)",
    'scrubber defect with names withheld: 0/40 files (0.00%, limit 1%)',
    'requests: 3 (batch size 40, 1 splits, cap 3); unanswered: 1',
    'tokens: 1000000 in, 50 out; cost $0.0420',
    'majority  18.0%   neighbour-vote  30.0%   k-NN  43.0%   model  50.0%',
    'name-withheld ablation (not a score): 37.5% (-12.5 vs reader) — the gap is what names carry; the baselines above use those names, so they are not comparable to it',
    '(2 files in smaller families shown below, not averaged)',
    'spread (families with >= 20 samples): best selectors 95.0%, worst cli 15.0%, 80.0 points',
    'xml*',
    'src/daemon/replay/internal/session-replay-x.ts  daemon-server -> ad-replay p=0.61  via rename  "move replay"',
    'src/late.ts  request-cap: request cap 3 reached',
    'leak reference: raw-subject: 70.0% over 39 answered files (2 requests) — an upper bound with the answer leaked back in, NOT the score',
    'not a removability or correctness claim',
  ]) {
    assert.ok(text.includes(needle), `missing ${JSON.stringify(needle)} in:\n${text}`);
  }
});
