import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MINI_CORPUS_NAMES, miniCorpus } from './__fixtures__/mini-corpus.ts';
import type { EvaluateRequest, EvaluateResponse } from './jev-client.ts';
import type { LegibilityInputs } from './load.ts';
import { runLegibility, type RunDeps } from './run.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function fakeInputs(): LegibilityInputs {
  const corpus = miniCorpus();
  return {
    corpus,
    coupling: new Map(corpus.families.map((family) => [family, { Q: 0.1, outInFlow: 1 }])),
    namesByFamily: new Map(MINI_CORPUS_NAMES),
  };
}

function deps(
  overrides: Partial<RunDeps>,
  calls: EvaluateRequest[],
  out: string[],
  err: string[],
): RunDeps {
  return {
    env: { AI_GATEWAY_API_KEY: 'test-key' },
    repoRoot,
    load: fakeInputs,
    createEvaluator:
      () =>
      async (request: EvaluateRequest): Promise<EvaluateResponse> => {
        calls.push(request);
        const answers = Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [
            id,
            {
              // The fake "reads" the evidence: files whose imports include a beta path are
              // beta. It matches the path scrubbed or not, so both conditions behave alike.
              choice: /src\/(beta|«x»)\//.test(question.instructions) ? 'beta' : 'alpha',
              probabilities: { alpha: 0.4, beta: 0.5, '(root)': 0.1 },
            },
          ]),
        );
        return {
          answers,
          usage: { inputTokens: 100, outputTokens: 0 },
          confidence: Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.7])),
        };
      },
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    now: () => new Date('2026-09-19T00:00:00Z'),
    headCommit: () => 'abc1234',
    ...overrides,
  };
}

test('a missing key exits non-zero, names the variable and model, and performs no requests', async () => {
  const calls: EvaluateRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let loaded = false;
  const code = await runLegibility(
    [],
    deps({ env: {}, load: () => ((loaded = true), fakeInputs()) }, calls, out, err),
  );
  assert.equal(code, 1);
  assert.equal(calls.length, 0);
  assert.equal(loaded, false);
  assert.match(err.join(''), /AI_GATEWAY_API_KEY/);
  assert.match(err.join(''), /typesafe-ai\/jev/);
});

test('the CLI itself refuses without the key before touching the tree', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', 'scripts/legibility/run.ts', '--all'],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, AI_GATEWAY_API_KEY: '' } },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /AI_GATEWAY_API_KEY/);
  assert.match(result.stderr, /typesafe-ai\/jev/);
  assert.match(result.stderr, /No requests were made/);
});

test('a full run over a fake corpus writes the report, prints the leak rate, baselines, rows, and cost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legibility-run-'));
  try {
    const calls: EvaluateRequest[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const outPath = join(dir, 'report.json');
    const code = await runLegibility(
      ['--all', '--out', outPath, '--batch-size', '4', '--raw-subject'],
      deps({}, calls, out, err),
    );
    assert.equal(code, 0, err.join(''));
    const text = out.join('');
    assert.match(text, /scrubber defect under the name-withheld condition: 0\/6 files \(0\.00%\)/);
    assert.match(text, /name echo in reader evidence: \d+\/6 files/);
    assert.match(text, /evaluating 6 files \(reader \(scored\)\)/);
    assert.match(text, /evaluating 6 files \(leak reference: reader \(scored\) \+ raw-subject\)/);
    assert.match(text, /majority .* neighbour-vote .* k-NN .* model/);
    assert.match(text, /leak reference: reader \(scored\) \+ raw-subject: .* NOT the score/);
    assert.match(text, /cost \$/);
    // Two conditions over six files at four per call: two calls each.
    assert.equal(calls.length, 4);
    assert.deepEqual(Object.keys(calls[0]!.state), ['task', 'families', 'evidenceLegend']);
    assert.deepEqual(calls[0]!.state.families, ['(root)', 'alpha', 'beta']);
    const question = Object.values(calls[0]!.questions)[0]!;
    assert.deepEqual(question.criteria, { '(root)': null, alpha: null, beta: null });
    assert.doesNotMatch(
      question.instructions,
      /packages\/alpha\/src\/a\.ts/,
      'own path never shown',
    );

    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(report.generated.sample.all, true);
    assert.deepEqual(report.generated.sample.ids.length, 6);
    assert.equal(report.leak.rate, 0, 'names withheld: the scrubber is clean');
    assert.ok(report.nameEcho.rate > 0, 'reader evidence carries the name echo it measures');
    assert.equal(report.ablation, null, 'no second pass without --ablation');
    assert.equal(report.requests.count, 2);
    assert.equal(report.usage.inputTokens, 400, 'scored + reference tokens both counted');
    assert.equal(report.perFamily.length, 3);
    assert.equal(
      report.leakReferences[0].condition,
      'leak reference: reader (scored) + raw-subject',
    );
    const beta = report.perFamily.find((row: { family: string }) => row.family === 'beta');
    // x and y import a `src/«x»/` path and read as beta; z imports only the alpha package.
    assert.equal(beta.accuracy, 2 / 3);
    assert.equal(beta.medianConfidence, 0.7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--ablation evaluates names withheld as a second pass and reports the gap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legibility-ablation-'));
  try {
    const calls: EvaluateRequest[] = [];
    const out: string[] = [];
    const err: string[] = [];
    const outPath = join(dir, 'report.json');
    const code = await runLegibility(
      ['--all', '--ablation', '--out', outPath, '--batch-size', '4'],
      deps({}, calls, out, err),
    );
    assert.equal(code, 0, err.join(''));
    // Two conditions over six files at four per call: two calls each.
    assert.equal(calls.length, 4);
    const scoredTasks = new Set(calls.map((call) => call.state.task));
    assert.equal(scoredTasks.size, 2, 'the second pass is told names are withheld');
    assert.match(calls[2]!.state.task, /replaced by «x»/);
    assert.doesNotMatch(calls[2]!.state.task, /real repository paths/);

    const text = out.join('');
    assert.match(text, /evaluating 6 files \(name-withheld ablation \(not a score\)\)/);
    assert.match(text, /name-withheld ablation .* not comparable to it/);

    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(report.ablation.condition, 'name-withheld ablation (not a score)');
    assert.equal(report.usage.inputTokens, 400, 'both passes counted');
    // This fake reads the paths either way, so the measured gap is zero rather than absent.
    assert.equal(report.ablation.delta, 0);
    assert.equal(report.ablation.accuracy, report.baselines.model);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the seeded sample is recorded and identical across runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'legibility-seed-'));
  try {
    const ids = async (seed: string) => {
      const outPath = join(dir, `${seed}.json`);
      await runLegibility(
        ['--sample', '4', '--seed', seed, '--out', outPath],
        deps({}, [], [], []),
      );
      return JSON.parse(readFileSync(outPath, 'utf8')).generated.sample.ids as string[];
    };
    assert.deepEqual(await ids('11'), await ids('11'));
    assert.equal((await ids('11')).length, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed flag is rejected with usage', async () => {
  await assert.rejects(
    runLegibility(['--sample', 'lots'], deps({}, [], [], [])),
    /--sample expects a positive integer/,
  );
});
