import { describe, expect, test } from 'vitest';
import {
  buildJevRequest,
  DECLINE_LABEL,
  JEV_USD_PER_INPUT_TOKEN,
  readJevDecision,
} from './jev-composer.ts';
import type { PolicyCandidate, PolicyRequest } from './policy-contract.ts';

const candidates: PolicyCandidate[] = [
  { ref: '@e2', role: 'text', name: 'Enter the code we texted you' },
  { ref: '@e5', role: 'textfield', name: 'Code', identifier: 'codeField', value: '' },
  { ref: '@e6', role: 'button', name: 'Verify', disabled: true },
];

const request: PolicyRequest = {
  goal: 'sign in',
  candidates,
  history: ['pressed Send code'],
  screen: 'Enter the code we texted you | Code',
  textReadyRefs: ['@e5'],
};

const meta = { provider: 'jev', model: 'jev-latest', decideMs: 187 };

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'jev-1.13.0',
    answers: {
      next: {
        type: 'choice',
        choice: '@e5',
        confidence: 0.97,
        probabilities: { '@e5': 0.97, [DECLINE_LABEL]: 0.03 },
      },
      done: { type: 'noul', noul: 0.02 },
      blocked: { type: 'noul', noul: 0.11 },
    },
    usage: { input_tokens: 500, output_tokens: 64 },
    ...overrides,
  };
}

describe('jev request composition', () => {
  test('offers every enabled element plus a decline label as choices', () => {
    const body = buildJevRequest('jev-latest', request);
    const criteria = (body.questions.next as { criteria: Record<string, unknown> }).criteria;
    expect(Object.keys(criteria).sort()).toEqual(['@e5', DECLINE_LABEL]);
  });

  test('sends the full element list as state, so text stays available as context', () => {
    const body = buildJevRequest('jev-latest', request);
    expect(body.state.elements).toEqual(candidates);
    expect(body.state.history).toEqual(['pressed Send code']);
  });

  test('marks a field the caller has text for, without carrying the text', () => {
    const body = buildJevRequest('jev-latest', request);
    const criteria = (body.questions.next as { criteria: Record<string, unknown> }).criteria;
    expect(criteria['@e5']).toMatchObject({ text_ready_to_enter: true });
    expect(JSON.stringify(body)).not.toContain('482493');
  });

  test('refuses a screen with nothing actionable on it', () => {
    expect(() =>
      buildJevRequest('jev-latest', { ...request, candidates: candidates.slice(0, 1) }),
    ).toThrow(
      expect.objectContaining({
        code: 'COMMAND_FAILED',
        message: expect.stringContaining('No actionable element'),
      }),
    );
  });
});

describe('jev decision parsing', () => {
  test('reads a decision from a well-formed response', () => {
    expect(readJevDecision(answer(), request, meta)).toEqual({
      action: 'fill',
      target: '@e5',
      done: false,
      blocked: false,
      needsText: true,
      confidence: 0.97,
      probabilities: { '@e5': 0.97, [DECLINE_LABEL]: 0.03 },
      provider: 'jev',
      model: 'jev-1.13.0',
      decideMs: 187,
      inputTokens: 500,
      costUsd: 500 * JEV_USD_PER_INPUT_TOKEN,
    });
  });

  test('reports a press when the chosen field already holds a value', () => {
    const filled: PolicyRequest = {
      ...request,
      candidates: candidates.map((candidate) =>
        candidate.ref === '@e5' ? { ...candidate, value: '4821' } : candidate,
      ),
    };
    const decision = readJevDecision(answer(), filled, meta);
    expect(decision.action).toBe('press');
    expect(decision.needsText).toBe(false);
  });

  test('reads a decline as no target', () => {
    const declined = answer({
      answers: {
        next: {
          type: 'choice',
          choice: DECLINE_LABEL,
          confidence: 0.6,
          probabilities: { [DECLINE_LABEL]: 0.6, '@e5': 0.4 },
        },
        done: { type: 'noul', noul: 0.1 },
        blocked: { type: 'noul', noul: 0.8 },
      },
    });
    const decision = readJevDecision(declined, request, meta);
    expect(decision.target).toBeNull();
    expect(decision.action).toBe('none');
    expect(decision.blocked).toBe(true);
  });

  test('rejects a choice that is not one of the offered elements', () => {
    const invented = answer({
      answers: {
        next: { type: 'choice', choice: '@e99', confidence: 1, probabilities: { '@e99': 1 } },
        done: { type: 'noul', noul: 0 },
        blocked: { type: 'noul', noul: 0 },
      },
    });
    expect(() => readJevDecision(invented, request, meta)).toThrow(
      expect.objectContaining({
        code: 'COMMAND_FAILED',
        message: expect.stringContaining('not a candidate element'),
      }),
    );
  });

  test('rejects a confidence outside zero to one', () => {
    const broken = answer({
      answers: {
        next: { type: 'choice', choice: '@e5', confidence: 4, probabilities: { '@e5': 1 } },
        done: { type: 'noul', noul: 0 },
        blocked: { type: 'noul', noul: 0 },
      },
    });
    expect(() => readJevDecision(broken, request, meta)).toThrow(
      expect.objectContaining({ code: 'COMMAND_FAILED' }),
    );
  });

  test('rejects a response with no answers at all', () => {
    expect(() => readJevDecision({ usage: {} }, request, meta)).toThrow(
      expect.objectContaining({ message: expect.stringContaining('answers is missing') }),
    );
  });
});
