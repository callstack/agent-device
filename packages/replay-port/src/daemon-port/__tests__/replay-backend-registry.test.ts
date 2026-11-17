import { getReplayPluginInstallation } from '@agent-device/ad-script';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { getReplayBackendDeclaration } from '../replay-backend-declarations.ts';
import { getReplayBackend, openReplayBackend } from '../replay-backend-registry.ts';
import { pluginHome, selectV2Plugin } from '@agent-device/test-kit';

test('help declares the exact optional package without requiring a working plugin', () => {
  expect(
    getReplayBackendDeclaration(
      getReplayPluginInstallation('maestro'),
      getReplayPluginInstallation('ad'),
    ),
  ).toMatchObject({
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

test('client replay absence does not evaluate unrelated provider packages', async () => {
  const { home, env } = pluginHome();
  const evaluated = path.join(home, 'provider-evaluated');
  selectV2Plugin(
    home,
    '@example/unrelated',
    `import fs from 'node:fs';
     fs.writeFileSync(${JSON.stringify(evaluated)}, 'evaluated');
     throw new Error('Unrelated provider import');`,
  );
  await expect(openReplayBackend('maestro', { env, cwd: '/' })).rejects.toMatchObject({
    details: {
      reason: 'plugin-not-installed',
      package: '@agent-device/maestro',
      installCommand: 'agent-device plugins add @agent-device/maestro',
    },
  });
  expect(fs.existsSync(evaluated)).toBe(false);
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
