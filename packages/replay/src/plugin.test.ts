import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { expect, test, vi } from 'vitest';
import { createPluginHost } from '@agent-device/plugins/host';
import { resolveProviderPlugins, startProviderRegistry } from '@agent-device/plugins/registry';
import replayPlugin from './plugin.ts';

test('the first-party factory uses the managed registry and preserves native script syntax', async () => {
  const registry = await startProviderRegistry(
    await resolveProviderPlugins([{ source: 'embedder', load: replayPlugin }]),
    {},
    {
      adaptWebDriver: async () => {
        throw new Error('Replay cannot create providers');
      },
    },
  );
  try {
    const execution = await registry.resolveReplayExecution();
    const manifest = execution.inspectAdReplay(
      'open com.example.app\nfill "id=password" "${PASSWORD}"\nclose',
    );
    expect(manifest.actions.map((action) => action.command)).toEqual(['open', 'fill', 'close']);
    expect(manifest.actions[1]?.positionals).toContain('${PASSWORD}');
    const artifactsDir = mkdtempForTestSync('replay-plugin-suite-');
    const sourcePath = path.join(artifactsDir, 'flow.ad');
    fs.writeFileSync(sourcePath, 'open com.example.app\nclose\n');
    const runReplay = vi.fn(async () => ({
      status: 'passed' as const,
      replayed: 2,
      healed: 0,
      warnings: [],
      artifactPaths: [],
    }));
    const cleanupSession = vi.fn(async () => {});
    const release = vi.fn();
    const suite = await execution.runReplayTestSuite({
      request: {
        inputs: [sourcePath],
        sessionName: 'package-suite',
        artifactsDir,
      },
      runReplay,
      cleanupSession,
      emitProgress: () => {},
      isCanceled: () => false,
      emitDiagnostic: () => {},
      bindAttemptCancellation: () => ({ cancel: () => {}, release }),
      discoverSources: () => [
        { path: sourcePath, manifest: { device: { platform: { kind: 'unspecified' } } } },
      ],
      resolveShardTargets: async () => [],
    });
    expect(suite, JSON.stringify(suite)).toMatchObject({
      status: 'completed',
      data: { passed: 1, failed: 0 },
    });
    expect(runReplay).toHaveBeenCalledOnce();
    expect(cleanupSession).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    await registry.close();
  }
});

test.each(['0.23.0', '0.21.39-dev'])('the package rejects unverified core %s', (clientVersion) => {
  const host = { ...createPluginHost({}, undefined), clientVersion };
  expect(() => replayPlugin().setup(host)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'incompatible_plugin' }),
    }),
  );
});

test.each(['0.21.38-dev', '0.22.0-beta.1', '0.22.0'])(
  'the package accepts declared core %s',
  (clientVersion) => {
    expect(
      replayPlugin().setup({ ...createPluginHost({}, undefined), clientVersion }),
    ).toMatchObject({ execution: { create: expect.any(Function) } });
  },
);
