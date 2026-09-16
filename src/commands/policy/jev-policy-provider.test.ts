import { describe, expect, test } from 'vitest';
import { createJevPolicyProvider } from './jev-policy-provider.ts';
import type { PolicyRequest } from './policy-contract.ts';

const request: PolicyRequest = {
  goal: 'sign in',
  candidates: [
    { ref: '@e5', role: 'textfield', name: 'Phone number', identifier: 'phoneField', value: '' },
    { ref: '@e6', role: 'button', name: 'Send code' },
  ],
  history: [],
  screen: 'Phone number | Send code',
  textReadyRefs: [],
};

const body = {
  model: 'jev-1.13.0',
  answers: {
    next: {
      type: 'choice',
      choice: '@e5',
      confidence: 0.99,
      probabilities: { '@e5': 0.99, '@e6': 0.01 },
    },
    done: { type: 'noul', noul: 0.01 },
    blocked: { type: 'noul', noul: 0.9 },
  },
  usage: { input_tokens: 412 },
};

function respondWith(status: number, payload: unknown): typeof globalThis.fetch {
  return (async () =>
    new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof globalThis.fetch;
}

describe('jev policy provider', () => {
  test('sends the key as a bearer token and returns a typed decision', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const provider = createJevPolicyProvider({
      apiKey: 'test-key',
      now: () => 0,
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof globalThis.fetch,
    });

    const decision = await provider.decide(request);

    expect(seen?.url).toBe('https://api.typesafe.ai/v1/systemone');
    const headers = seen?.init.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer test-key');
    expect(decision.target).toBe('@e5');
    expect(decision.action).toBe('fill');
    expect(decision.blocked).toBe(true);
    expect(decision.inputTokens).toBe(412);
  });

  test('reports a rejected key as unauthorized, naming the fallback', async () => {
    const provider = createJevPolicyProvider({
      apiKey: 'bad',
      fetch: respondWith(401, { error: 'invalid key' }),
    });
    await expect(provider.decide(request)).rejects.toThrow(
      expect.objectContaining({
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('Jev unavailable: 401'),
      }),
    );
  });

  test('marks a rate limit retriable and a payment failure not', async () => {
    const limited = createJevPolicyProvider({ apiKey: 'k', fetch: respondWith(429, 'slow down') });
    await expect(limited.decide(request)).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: { reason: 'policy-provider-rate-limited', retriable: true, status: 429 },
    });

    const unpaid = createJevPolicyProvider({ apiKey: 'k', fetch: respondWith(402, 'no credit') });
    await expect(unpaid.decide(request)).rejects.toMatchObject({
      details: { reason: 'policy-provider-payment-required', retriable: false, status: 402 },
    });
  });

  test('reports a transport failure as retriable rather than as a decision', async () => {
    const provider = createJevPolicyProvider({
      apiKey: 'k',
      fetch: (async () => {
        throw new Error('socket hang up');
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(provider.decide(request)).rejects.toMatchObject({
      message: 'Jev unavailable: socket hang up',
      details: { reason: 'policy-provider-transport', retriable: true },
    });
  });

  test('measures decide time from the injected clock', async () => {
    let clock = 1_000;
    const provider = createJevPolicyProvider({
      apiKey: 'k',
      fetch: respondWith(200, body),
      now: () => {
        const value = clock;
        clock += 203;
        return value;
      },
    });
    expect((await provider.decide(request)).decideMs).toBe(203);
  });
});
