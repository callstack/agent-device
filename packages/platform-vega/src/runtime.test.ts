import { expect, test } from 'vitest';
import { createVegaPlatformRuntime } from './runtime.ts';

test('classifies the Vega runtime denominator as unavailable', async () => {
  const binding = await createVegaPlatformRuntime().bind({
    device: {
      platform: 'vega',
      id: 'vega',
      name: 'Vega',
      kind: 'device',
      target: 'tv',
      booted: true,
    },
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  expect(binding.facts.operations.networkDump).toMatchObject({
    available: false,
    reason: 'unsupported-platform-leaf',
  });
});
