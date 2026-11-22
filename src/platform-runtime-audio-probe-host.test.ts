import { expect, test } from 'vitest';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { emptyAudioProbeResult } from '@agent-device/contracts/audio-probe-result';
import type { AudioProbeQueryInput } from '@agent-device/contracts/audio-probe-runtime';
import { createAudioProbeRuntimeHost } from './platform-runtime-audio-probe-host.ts';
import { bindAbsentMacOsLeafCompositionFixture } from './platform-runtime-macos-leaf.fixtures.ts';
import { makeWebProvider, webSelectionFixture } from './platform-runtime-web-provider.fixtures.ts';

const web = {
  platform: 'web' as const,
  id: 'browser',
  name: 'Browser',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

const webPlugin = webSelectionFixture();

test('an iOS or Android session without the macOS package answers plugin-not-installed when it samples host audio', async () => {
  // The host sampler is the macOS helper's, so the leaf starts it for every darwin-hosted family
  // (#4675). A composition that has no macOS package reports its install hint rather than a bare
  // failure: the caller can fix this one by installing a plugin.
  bindAbsentMacOsLeafCompositionFixture();
  const { hostCapture } = createAudioProbeRuntimeHost({ host: createTestHostEnvironment() });
  await expect(
    hostCapture.start({ durationMs: 1_000, bucketMs: 100, statusPath: '/tmp/audio-status.json' }),
  ).rejects.toMatchObject({
    code: 'UNSUPPORTED_PLATFORM',
    details: expect.objectContaining({
      reason: 'plugin-not-installed',
      family: 'apple',
      appleOs: 'macos',
      package: '@agent-device/macos',
      installCommand: expect.stringContaining('agent-device plugins add @agent-device/macos'),
      hint: expect.stringContaining('agent-device plugins add @agent-device/macos'),
    }),
  });
});

test('never falls back to the default browser session for a web audio probe', async () => {
  const { web: webAudio } = createAudioProbeRuntimeHost({
    host: createTestHostEnvironment(),
    web: webPlugin,
  });
  expect(await webAudio.resolve(web)).toBeUndefined();

  const actions: string[] = [];
  const query: AudioProbeQueryInput = { action: 'status', durationMs: 1000, bucketMs: 100 };
  await webPlugin.get().withRequestProvider(
    makeWebProvider({
      probeAudio: async (options) => {
        actions.push(options.action);
        return {
          ...emptyAudioProbeResult({
            source: 'media-elements',
            backend: 'agent-browser',
            durationMs: options.durationMs ?? 0,
            bucketMs: options.bucketMs ?? 0,
          }),
          source: 'media-elements' as const,
          mediaElementCount: 0,
        };
      },
    }),
    async () => {
      const transport = await webAudio.resolve(web);
      if (!transport) throw new Error('missing scoped web audio transport');
      await transport.probe(query);
    },
  );
  expect(actions).toEqual(['status']);
});
