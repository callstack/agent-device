import { getReplayPluginInstallation } from '@agent-device/ad-script';
import { expect, test } from 'vitest';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { getReplayBackendDeclaration } from '../replay-backend-declarations.ts';
import { getReplayBackend, openReplayBackend } from '../replay-backend-registry.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit';

test('help declares the exact optional package without requiring a working plugin', () => {
  expect(getReplayBackendDeclaration(getReplayPluginInstallation('maestro'))).toMatchObject({
    id: 'maestro',
    package: '@agent-device/maestro',
  });
});

test('the runtime registry memoizes the installed backend capabilities', async () => {
  const first = await getReplayBackend('maestro');
  expect(await getReplayBackend('maestro')).toBe(first);
  expect(first.inspectSource('appId: com.example.app\n---\n- launchApp\n', 'flow.yaml')).toEqual({
    title: undefined,
    appTarget: 'com.example.app',
  });
});

test('absence gives a vetted install command and preserves the host installation boundary', async () => {
  await expect(
    openReplayBackend('maestro', {
      AGENT_DEVICE_HOME: mkdtempForTestSync('missing-replay-plugin-'),
    }),
  ).rejects.toMatchObject({
    details: {
      reason: 'plugin-not-installed',
      package: '@agent-device/maestro',
      installCommand: 'agent-device plugins add @agent-device/maestro',
    },
  });
});

test('an unbound daemon runtime never borrows another runtime or the client store', async () => {
  const isolated = createRuntimeStateHandle();
  try {
    await isolated.run(
      async () =>
        await expect(getReplayBackend('maestro')).rejects.toMatchObject({
          details: { reason: 'plugin-not-installed' },
        }),
    );
  } finally {
    isolated.dispose();
  }
});
