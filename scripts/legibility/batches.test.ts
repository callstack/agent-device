import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateInBatches, type BatchItem } from './batches.ts';
import type { ChoiceQuestion, EvaluateRequest, EvaluateResponse } from './jev-client.ts';

const CRITERIA = { alpha: null, beta: null, gamma: null };

function item(id: string, evidence = id): BatchItem {
  const question: ChoiceQuestion = { type: 'choice', instructions: evidence, criteria: CRITERIA };
  return { id, question };
}

/** Answers `beta` for everything; fails the whole call when any question carries the tie marker. */
function fakeEvaluator(calls: EvaluateRequest[]) {
  return async (request: EvaluateRequest): Promise<EvaluateResponse> => {
    calls.push(request);
    if (Object.values(request.questions).some((q) => q.instructions.includes('TIE'))) {
      const error = new Error('did not select a highest-probability option');
      error.name = 'InvalidResponseDataError';
      throw error;
    }
    const answers = Object.fromEntries(
      Object.keys(request.questions).map((id) => [
        id,
        { choice: 'beta', probabilities: { alpha: 0.3, beta: 0.6, gamma: 0.1 } },
      ]),
    );
    return {
      answers,
      usage: { inputTokens: 10 * Object.keys(request.questions).length, outputTokens: 0 },
      confidence: Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.8])),
    };
  };
}

test('batches by size, keeps the raw choice, selected probability, top-3, and confidence', async () => {
  const calls: EvaluateRequest[] = [];
  const run = await evaluateInBatches([item('a'), item('b'), item('c')], fakeEvaluator(calls), {
    state: { task: 't' },
    batchSize: 2,
    maxRequests: 10,
  });
  assert.equal(run.requests, 2);
  assert.equal(run.splits, 0);
  assert.deepEqual(Object.keys(calls[0]!.questions), ['f0', 'f1']);
  assert.deepEqual(calls[0]!.state, { task: 't' });
  assert.deepEqual(run.answers.get('c'), {
    id: 'c',
    choice: 'beta',
    p: 0.6,
    top3: [
      ['beta', 0.6],
      ['alpha', 0.3],
      ['gamma', 0.1],
    ],
    confidence: 0.8,
  });
  assert.equal(run.unanswered.size, 0);
  assert.deepEqual(run.usage, { inputTokens: 30, outputTokens: 0 });
});

test('a tie-failing batch halves recursively; answers survive; the culprit is unanswered with a typed reason', async () => {
  const calls: EvaluateRequest[] = [];
  const run = await evaluateInBatches(
    [item('a'), item('b'), item('tie', 'TIE'), item('c'), item('d')],
    fakeEvaluator(calls),
    { state: {}, batchSize: 5, maxRequests: 10 },
  );
  assert.deepEqual(
    calls.map((call) => Object.keys(call.questions).length),
    [5, 3, 2, 1, 2],
    'whole batch, first half, its halves, second half',
  );
  assert.equal(run.splits, 2);
  assert.equal(run.requests, 5);
  assert.deepEqual([...run.answers.keys()].sort(), ['a', 'b', 'c', 'd']);
  assert.deepEqual(run.unanswered.get('tie'), {
    kind: 'call-failed',
    errorName: 'InvalidResponseDataError',
    message: 'did not select a highest-probability option',
  });
});

test('the request cap stops further calls and records the rest as unanswered', async () => {
  const calls: EvaluateRequest[] = [];
  const run = await evaluateInBatches(
    [item('a'), item('b'), item('c'), item('d')],
    fakeEvaluator(calls),
    { state: {}, batchSize: 2, maxRequests: 1 },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual([...run.answers.keys()], ['a', 'b']);
  assert.deepEqual(run.unanswered.get('c'), { kind: 'request-cap', maxRequests: 1 });
  assert.deepEqual(run.unanswered.get('d'), { kind: 'request-cap', maxRequests: 1 });
});

test('a missing answer in an otherwise successful call is unanswered, not dropped', async () => {
  const run = await evaluateInBatches(
    [item('a'), item('b')],
    async (_request) => ({
      answers: { f0: { choice: 'alpha' } },
      usage: { inputTokens: undefined, outputTokens: undefined },
      confidence: undefined,
    }),
    { state: {}, batchSize: 2, maxRequests: 10 },
  );
  assert.deepEqual(run.answers.get('a'), {
    id: 'a',
    choice: 'alpha',
    p: null,
    top3: [],
    confidence: null,
  });
  assert.equal(run.unanswered.get('b')?.kind, 'call-failed');
  assert.deepEqual(run.usage, { inputTokens: 0, outputTokens: 0 });
});
