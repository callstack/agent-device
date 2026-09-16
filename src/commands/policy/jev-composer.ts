import { AppError } from '@agent-device/kernel/errors';
import { isTextEntryRole, selectableCandidates } from './candidate-elements.ts';
import { POLICY_FALLBACK_HINT } from './policy-fallback.ts';
import type { PolicyCandidate, PolicyDecision, PolicyRequest } from './policy-contract.ts';

/**
 * The label a choice question carries for "no element on this screen advances the goal". A ref can
 * never collide with it: refs are `@`-prefixed.
 */
export const DECLINE_LABEL = '__none__';

/**
 * Published input-token price for the TypeSafe System One API, in US dollars. Output tokens are
 * not billed. A wrong constant only mis-reports the `costUsd` field; it never changes behaviour.
 */
export const JEV_USD_PER_INPUT_TOKEN = 42 / 1e9;

const CHOICE_RULES = [
  'Fill an empty required field before pressing the control that submits it',
  'Never choose a disabled element',
  'Prefer the most direct remaining step towards the goal',
  'Do not repeat an action the history shows already succeeded',
  'A field marked text_ready_to_enter can be filled immediately; its text is already available',
] as const;

export type JevRequestBody = {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, unknown>;
};

/** Compose the System One request for one screen. Pure: no clock, no network, no environment. */
export function buildJevRequest(model: string, request: PolicyRequest): JevRequestBody {
  const selectable = selectableCandidates(request.candidates);
  if (selectable.length === 0) {
    throw new AppError('COMMAND_FAILED', 'No actionable element is visible on the current screen', {
      reason: 'policy-no-candidates',
      hint: 'Take a snapshot to confirm the screen rendered, then retry.',
    });
  }

  const criteria: Record<string, unknown> = {
    [DECLINE_LABEL]: 'No visible element advances the goal; stop and hand back to the caller',
  };
  const textReady = new Set(request.textReadyRefs);
  for (const candidate of selectable) {
    criteria[candidate.ref] = {
      role: candidate.role,
      name: candidate.name,
      ...(candidate.value === undefined ? {} : { value: candidate.value }),
      // The caller holds text for this field, so needing it is not a reason to report blocked.
      ...(textReady.has(candidate.ref) ? { text_ready_to_enter: true } : {}),
    };
  }

  return {
    model,
    state: {
      goal: request.goal,
      screen: request.screen,
      elements: request.candidates,
      history: request.history,
      fields_with_text_ready: request.textReadyRefs,
    },
    questions: {
      next: {
        type: 'choice',
        instructions: {
          question: 'Which element should be acted on next to advance the goal',
          rules: CHOICE_RULES,
        },
        criteria,
      },
      done: {
        type: 'noul',
        instructions: 'The goal is already fully achieved on the current screen',
      },
      blocked: {
        type: 'noul',
        instructions:
          'Progress needs information or a credential that is neither on this screen, nor already available for a field marked text_ready_to_enter, nor obtainable by acting on this screen',
      },
    },
  };
}

/**
 * Read a System One response into a typed decision.
 *
 * Every field is validated against the candidate set rather than trusted: a label outside the
 * criteria, or a probability that is not a number, is a provider fault and is reported as one.
 */
export function readJevDecision(
  body: unknown,
  request: PolicyRequest,
  meta: { provider: string; model: string; decideMs: number },
): PolicyDecision {
  const answers = readRecord(readRecord(body, 'response body').answers, 'answers');
  const next = readRecord(answers.next, 'answers.next');
  const target = readChoice(next.choice, request.candidates);

  const chosen =
    target === null ? undefined : request.candidates.find((candidate) => candidate.ref === target);
  const needsText = chosen !== undefined && isTextEntryRole(chosen.role) && !chosen.value;

  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;

  return {
    action: target === null ? 'none' : needsText ? 'fill' : 'press',
    target,
    done: readNoul(answers.done, 'answers.done') > 0.5,
    blocked: readNoul(answers.blocked, 'answers.blocked') > 0.5,
    needsText,
    confidence: readUnitInterval(next.confidence, 'answers.next.confidence'),
    probabilities: readProbabilities(next.probabilities),
    provider: meta.provider,
    model:
      typeof (body as { model?: unknown }).model === 'string'
        ? (body as { model: string }).model
        : meta.model,
    decideMs: meta.decideMs,
    inputTokens,
    costUsd: inputTokens * JEV_USD_PER_INPUT_TOKEN,
  };
}

function readChoice(value: unknown, candidates: readonly PolicyCandidate[]): string | null {
  if (typeof value !== 'string') {
    throw providerFault('answers.next.choice is not a string');
  }
  if (value === DECLINE_LABEL) return null;
  if (!candidates.some((candidate) => candidate.ref === value)) {
    throw providerFault(`answers.next.choice named ${value}, which is not a candidate element`);
  }
  return value;
}

function readProbabilities(value: unknown): Record<string, number> {
  if (!isRecord(value)) throw providerFault('answers.next.probabilities is not an object');
  const probabilities: Record<string, number> = {};
  for (const [label, probability] of Object.entries(value)) {
    probabilities[label] = readUnitInterval(probability, `probability for ${label}`);
  }
  return probabilities;
}

function readNoul(value: unknown, field: string): number {
  return readUnitInterval(readRecord(value, field).noul, `${field}.noul`);
}

function readUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw providerFault(`${field} is not a probability between 0 and 1`);
  }
  return value;
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw providerFault(`${field} is missing or not an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function providerFault(message: string): AppError {
  return new AppError('COMMAND_FAILED', `Jev returned an unusable decision: ${message}`, {
    reason: 'policy-provider-response',
    hint: `Retry, or ${POLICY_FALLBACK_HINT}`,
  });
}
