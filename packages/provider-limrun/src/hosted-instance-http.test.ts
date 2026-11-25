import { expect, test, vi } from 'vitest';
import { refuseHostedInstanceRedirects } from './hosted-instance-http.ts';

test('acquiring another hosted scope restores redirect refusal after fetch is replaced', async () => {
  const original = globalThis.fetch;
  const fallback = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response());
  const releaseFirst = refuseHostedInstanceRedirects(['first-fixture']);
  let releaseSecond: (() => void) | undefined;
  try {
    globalThis.fetch = fallback;
    releaseSecond = refuseHostedInstanceRedirects(['second-fixture']);
    for (const token of ['first-fixture', 'second-fixture']) {
      await fetch('https://instance.example', { headers: { authorization: `Bearer ${token}` } });
    }
    expect(fallback.mock.calls.map(([, init]) => init?.redirect)).toEqual(['error', 'error']);
    releaseFirst();
    releaseSecond();
    expect(globalThis.fetch).toBe(fallback);
  } finally {
    releaseSecond?.();
    releaseFirst();
    globalThis.fetch = original;
  }
});
