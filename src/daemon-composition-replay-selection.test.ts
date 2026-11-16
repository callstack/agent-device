import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createRuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';
import { storePluginCandidates } from '@agent-device/plugins/store';
import {
  getReplayBackend,
  getReplayExecution,
} from '@agent-device/replay-port/replay-backend-registry';
import {
  createTestHostEnvironment,
  mkdtempForTestSync,
  pluginHome,
  selectV2Plugin,
} from '@agent-device/test-kit';
import { composeDaemonRuntimeDeps } from './daemon-composition.ts';

function pluginSource(backend: 'ad' | 'maestro') {
  const capability =
    backend === 'ad'
      ? `execution: { create: () => ({
          inspectAdReplay() {}, runAdReplay() {}, runReplayTestSuite() {}
        }) }`
      : `replayBackend: { create: () => ({
          id: 'maestro', collectSourceFiles() {}, inspectSource() {},
          runReplay() {}, exportReplayScript() {}
        }) }`;
  return `export default () => ({
    apiVersion: 2, kind: 'replay-backend', backend: '${backend}',
    setup: () => ({ ${capability} })
  });`;
}

async function composedRuntime(env: NodeJS.ProcessEnv, embedded = false) {
  const state = createRuntimeStateHandle();
  const baseDir = mkdtempForTestSync('replay-selection-runtime-');
  const candidates = embedded ? await storePluginCandidates(env) : undefined;
  try {
    const deps = await state.run(() =>
      composeDaemonRuntimeDeps(
        {
          host: createTestHostEnvironment({ env }),
          baseDir,
          sessionsDir: path.join(baseDir, 'sessions'),
          assertShutdownAllowed: undefined,
          resolveSessionDir: (id) => path.join(baseDir, 'sessions', id),
          resolveSessionArtifacts: () => {
            throw new Error('Replay resolution must not create a session');
          },
          openWebSessionNames: () => [],
        },
        candidates,
      ),
    );
    return {
      resolve: (backend: 'ad' | 'maestro') =>
        state.run(() => (backend === 'ad' ? getReplayExecution() : getReplayBackend(backend))),
      close: async () => {
        await deps.shutdownProviderRuntimes();
        state.dispose();
      },
    };
  } catch (error) {
    state.dispose();
    throw error;
  }
}

test.each([
  ['ad', 'replace'],
  ['ad', 'remove'],
  ['maestro', 'replace'],
  ['maestro', 'remove'],
] as const)(
  'daemon refuses a retained custom %s implementation after %s',
  async (backend, change) => {
    const { home, env } = pluginHome();
    const name = `@example/${backend}`;
    const source = pluginSource(backend);
    selectV2Plugin(home, name, source);
    const runtime = await composedRuntime(env);
    try {
      const first = await runtime.resolve(backend);
      selectV2Plugin(home, '@example/unrelated', pluginSource(backend));
      expect(await runtime.resolve(backend)).toBe(first);
      if (change === 'replace') {
        selectV2Plugin(home, name, source);
      } else {
        const configPath = path.join(home, 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        delete config.plugins[name];
        fs.writeFileSync(configPath, JSON.stringify(config));
      }
      await expect(runtime.resolve(backend)).rejects.toMatchObject({
        details: { reason: 'daemon-plugin-set-stale', package: name },
      });
    } finally {
      await runtime.close();
    }
  },
);

test.each(['ad', 'maestro'] as const)(
  'embedded %s implementations remain independent of store changes',
  async (backend) => {
    const { home, env } = pluginHome();
    selectV2Plugin(home, `@example/${backend}`, pluginSource(backend));
    const runtime = await composedRuntime(env, true);
    try {
      const first = await runtime.resolve(backend);
      fs.writeFileSync(path.join(home, 'config.json'), '{broken');
      expect(await runtime.resolve(backend)).toBe(first);
    } finally {
      await runtime.close();
    }
  },
);

test.each([
  ['ad', '@agent-device/replay'],
  ['maestro', '@agent-device/maestro'],
] as const)(
  'a newly installed %s catalog package requires daemon restart',
  async (backend, name) => {
    const { home, env } = pluginHome();
    const runtime = await composedRuntime(env);
    try {
      await expect(runtime.resolve(backend)).rejects.toMatchObject({
        details: { reason: 'plugin-not-installed', package: name },
      });
      selectV2Plugin(home, name, pluginSource(backend));
      await expect(runtime.resolve(backend)).rejects.toMatchObject({
        details: { reason: 'daemon-plugin-set-stale', package: name },
      });
    } finally {
      await runtime.close();
    }
  },
);
