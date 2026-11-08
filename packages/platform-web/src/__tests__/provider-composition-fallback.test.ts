import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { resolveRequestScopedWebProvider, resolveWebProviderForHost } from '../resolve-provider.ts';
import { resolveWebProvider, withWebProvider } from '../provider.ts';
import { makeWebProvider } from './test-utils.ts';

// The scope's un-composed fallback is the single policy for a request that reaches a web device
// without a composed provider: it refuses with `web-provider-missing` instead of borrowing a host
// it was never given (#3794).
test('an un-scoped web provider resolves to a refusal naming the missing composition', async () => {
  const provider = resolveWebProvider();
  const operations: readonly [string, () => Promise<unknown>][] = [
    ['open', () => provider.open('https://example.test')],
    ['close', () => provider.close()],
    ['snapshot', () => provider.snapshot()],
    ['screenshot', () => provider.screenshot('/tmp/out.png')],
    ['setViewport', () => provider.setViewport(800, 600)],
    ['click', () => provider.click(1, 2)],
    ['fill', () => provider.fill(1, 2, 'text')],
    ['typeText', () => provider.typeText('text')],
    ['scroll', () => provider.scroll('down')],
  ];
  for (const [operation, call] of operations) {
    const error = await call().then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(error instanceof AppError, `${operation} refuses with an AppError`);
    assert.equal(error.details?.reason, 'web-provider-missing', operation);
  }
});

test('a composed request provider answers instead of the fallback refusal', async () => {
  const opened: string[] = [];
  const provider = makeWebProvider({
    open: async (target) => {
      opened.push(target);
    },
  });
  await withWebProvider(provider, async () => {
    await resolveWebProvider().open('https://example.test');
  });
  assert.deepEqual(opened, ['https://example.test']);
});

test('the request-scoped resolver answers only inside a composed request, and the host resolver falls back', async () => {
  const provider = makeWebProvider();
  const host = createTestHostEnvironment();
  assert.equal(await resolveRequestScopedWebProvider(), undefined);
  assert.notEqual(await resolveWebProviderForHost(host), provider);
  await withWebProvider(provider, async () => {
    assert.equal(await resolveRequestScopedWebProvider(), provider);
    assert.equal(await resolveWebProviderForHost(host), provider);
  });
  assert.equal(await resolveWebProviderForHost(host, provider), provider);
});
