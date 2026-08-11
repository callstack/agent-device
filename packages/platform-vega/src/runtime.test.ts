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
  expect(binding.facts.operations.appState).toMatchObject({ available: false });
  expect(binding.facts.operations.ensureReady).toMatchObject({ available: false });
  expect(binding.facts.operations.bootTarget).toMatchObject({ available: false });
  expect(binding.facts.operations.bootTargetHeadless).toMatchObject({ available: false });
  expect(binding.facts.operations.listApps).toMatchObject({ available: false });
});
