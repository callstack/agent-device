import { expect, test } from 'vitest';
import { createLinuxPlatformRuntime } from './runtime.ts';

test('classifies the Linux runtime denominator as unavailable', async () => {
  const binding = await createLinuxPlatformRuntime().bind({
    device: {
      platform: 'linux',
      id: 'linux',
      name: 'Linux',
      kind: 'device',
      target: 'desktop',
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
