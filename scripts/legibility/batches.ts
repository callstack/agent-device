// Batched evaluation with split-and-retry. One call carries up to `batchSize` questions; when
// the whole call fails validation — the provider rounds to two decimals, so a tie at the top
// makes it "not select a highest-probability option" and discards every answer in the call —
// the batch is halved and each half retried, recursively. A single file that still fails is
// recorded as unanswered with a typed reason, never dropped. Requests are capped per run.

import type { ChoiceQuestion, EvaluateRequest, EvaluateResponse, Evaluator } from './jev-client.ts';

export type BatchItem = { id: string; question: ChoiceQuestion };

export type FileAnswer = {
  id: string;
  choice: string;
  /** Probability of the selected option, when the provider returned a distribution. */
  p: number | null;
  /** The three most probable options, when a distribution was returned. */
  top3: [string, number][];
  /** Provider confidence for this question — a separate statistic from `p`. */
  confidence: number | null;
};

export type UnansweredReason =
  | { kind: 'call-failed'; errorName: string; message: string }
  | { kind: 'request-cap'; maxRequests: number };

export type BatchRun = {
  answers: Map<string, FileAnswer>;
  unanswered: Map<string, UnansweredReason>;
  requests: number;
  splits: number;
  usage: { inputTokens: number; outputTokens: number };
};

export type BatchOptions = {
  state: EvaluateRequest['state'];
  batchSize: number;
  maxRequests: number;
  onProgress?: (run: BatchRun, pending: number) => void;
};

export const DEFAULT_BATCH_SIZE = 40;
export const DEFAULT_MAX_REQUESTS = 200;

function topThree(probabilities: Record<string, number> | undefined): [string, number][] {
  if (!probabilities) return [];
  return Object.entries(probabilities)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, 3);
}

function callFailed(errorName: string, message: string): UnansweredReason {
  return { kind: 'call-failed', errorName, message };
}

/** Records every answer of a successful call; a question the provider skipped is unanswered. */
function recordResponse(
  run: BatchRun,
  response: EvaluateResponse,
  idsByQuestion: ReadonlyMap<string, string>,
): void {
  run.usage.inputTokens += response.usage.inputTokens ?? 0;
  run.usage.outputTokens += response.usage.outputTokens ?? 0;
  for (const [questionId, id] of idsByQuestion) {
    const answer = response.answers[questionId];
    if (!answer) {
      run.unanswered.set(id, callFailed('MissingAnswer', `no answer for ${questionId}`));
      continue;
    }
    run.answers.set(id, {
      id,
      choice: answer.choice,
      p: answer.probabilities?.[answer.choice] ?? null,
      top3: topThree(answer.probabilities),
      confidence: response.confidence?.[questionId] ?? null,
    });
  }
}

function questionsFor(items: readonly BatchItem[]): {
  questions: Record<string, ChoiceQuestion>;
  idsByQuestion: Map<string, string>;
} {
  const questions: Record<string, ChoiceQuestion> = {};
  const idsByQuestion = new Map<string, string>();
  items.forEach((item, index) => {
    questions[`f${index}`] = item.question;
    idsByQuestion.set(`f${index}`, item.id);
  });
  return { questions, idsByQuestion };
}

async function evaluateBatch(
  items: readonly BatchItem[],
  evaluator: Evaluator,
  options: BatchOptions,
  run: BatchRun,
): Promise<void> {
  if (items.length === 0) return;
  if (run.requests >= options.maxRequests) {
    for (const item of items) {
      run.unanswered.set(item.id, { kind: 'request-cap', maxRequests: options.maxRequests });
    }
    return;
  }
  run.requests += 1;
  const { questions, idsByQuestion } = questionsFor(items);
  try {
    recordResponse(run, await evaluator({ state: options.state, questions }), idsByQuestion);
  } catch (error: unknown) {
    if (items.length === 1) {
      const name = error instanceof Error ? error.name : 'Error';
      const message = error instanceof Error ? error.message : String(error);
      run.unanswered.set(items[0]!.id, callFailed(name, message));
      return;
    }
    run.splits += 1;
    const middle = Math.ceil(items.length / 2);
    await evaluateBatch(items.slice(0, middle), evaluator, options, run);
    await evaluateBatch(items.slice(middle), evaluator, options, run);
  }
}

export async function evaluateInBatches(
  items: readonly BatchItem[],
  evaluator: Evaluator,
  options: BatchOptions,
): Promise<BatchRun> {
  const run: BatchRun = {
    answers: new Map(),
    unanswered: new Map(),
    requests: 0,
    splits: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  for (let start = 0; start < items.length; start += options.batchSize) {
    await evaluateBatch(items.slice(start, start + options.batchSize), evaluator, options, run);
    options.onProgress?.(run, Math.max(0, items.length - start - options.batchSize));
  }
  return run;
}
