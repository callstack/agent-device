// The one network seam. `Evaluator` is the shape the batch runner consumes; the production
// implementation wraps `experimental_evaluate` from `ai` with the AI Gateway evaluation model.
// Unit tests inject a fake. The key is read from the environment here and nowhere else, is
// passed to the gateway provider, and is never logged.

import { createGateway, experimental_evaluate } from 'ai';

export const JEV_MODEL_ID = 'typesafe-ai/jev';
export const GATEWAY_KEY_VARIABLE = 'AI_GATEWAY_API_KEY';

/** Gateway list price for the evaluation model's input tokens; output tokens are priced at zero. */
const INPUT_USD_PER_MILLION_TOKENS = 0.042;

export type ChoiceQuestion = {
  type: 'choice';
  instructions: string;
  criteria: Record<string, null>;
};

export type EvaluateRequest = {
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
};

export type EvaluateAnswer = { choice: string; probabilities?: Record<string, number> };

export type EvaluateResponse = {
  answers: Record<string, EvaluateAnswer>;
  usage: { inputTokens: number | undefined; outputTokens: number | undefined };
  /** Provider confidence per question id, when the provider reports one. */
  confidence: Record<string, number> | undefined;
};

export type Evaluator = (request: EvaluateRequest) => Promise<EvaluateResponse>;

export type MissingKey = { kind: 'missing-key'; variable: string; model: string };

export function readGatewayKey(
  env: NodeJS.ProcessEnv,
): { ok: true; apiKey: string } | { ok: false; error: MissingKey } {
  const apiKey = env[GATEWAY_KEY_VARIABLE];
  if (typeof apiKey === 'string' && apiKey.length > 0) return { ok: true, apiKey };
  return {
    ok: false,
    error: { kind: 'missing-key', variable: GATEWAY_KEY_VARIABLE, model: JEV_MODEL_ID },
  };
}

export function describeMissingKey(error: MissingKey): string {
  return (
    `legibility: ${error.variable} is not set; the placement-legibility report asks the ` +
    `${error.model} evaluation model through AI Gateway and cannot run without it. ` +
    `No requests were made.`
  );
}

function confidenceOf(metadata: unknown): Record<string, number> | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const typesafe = (metadata as { typesafe?: unknown }).typesafe;
  if (typeof typesafe !== 'object' || typesafe === null) return undefined;
  const confidence = (typesafe as { confidence?: unknown }).confidence;
  if (typeof confidence !== 'object' || confidence === null) return undefined;
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(confidence as Record<string, unknown>)) {
    if (typeof value === 'number') out[id] = value;
  }
  return out;
}

export function createJevEvaluator(options: { apiKey: string; model?: string }): Evaluator {
  const model = createGateway({ apiKey: options.apiKey }).evaluationModel(
    options.model ?? JEV_MODEL_ID,
  );
  return async (request) => {
    const result = await experimental_evaluate({
      model,
      state: request.state as Parameters<typeof experimental_evaluate>[0]['state'],
      questions: request.questions,
    });
    const answers: Record<string, EvaluateAnswer> = {};
    for (const [id, answer] of Object.entries(result.answers)) {
      answers[id] = { choice: answer.choice, probabilities: answer.probabilities };
    }
    return {
      answers,
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      confidence: confidenceOf(result.providerMetadata),
    };
  };
}

export function inputCostUsd(inputTokens: number): number {
  return (inputTokens / 1_000_000) * INPUT_USD_PER_MILLION_TOKENS;
}
