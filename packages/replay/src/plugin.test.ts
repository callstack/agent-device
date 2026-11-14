import { expect, test } from 'vitest';
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
    const suite = await execution.runReplayTestSuite({
      request: { inputs: [], sessionName: 'unused' },
    } as never);
    expect(suite).toEqual({
      status: 'failed',
      error: { code: 'INVALID_ARGS', message: 'test requires at least one path or glob' },
    });
  } finally {
    await registry.close();
  }
});

test('the package refuses a core outside its declared release family', async () => {
  const host = { ...createPluginHost({}, undefined), clientVersion: '0.23.0' };
  expect(() => replayPlugin().setup(host)).toThrow(
    expect.objectContaining({
      details: expect.objectContaining({ reason: 'incompatible_plugin' }),
    }),
  );
});
