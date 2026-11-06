import { expect, test } from 'vitest';
import { withWebProvider } from '@agent-device/platform-web';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { emptyAudioProbeResult } from '@agent-device/contracts/audio-probe-result';
import type { AudioProbeQueryInput } from '@agent-device/contracts/audio-probe-runtime';
import { createAudioProbeRuntimeHost } from './platform-runtime-audio-probe-host.ts';
import { makeWebProvider } from './platform-runtime-web-provider.fixtures.ts';

const web = {
  platform: 'web' as const,
  id: 'browser',
  name: 'Browser',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

test('never falls back to the default browser session for a web audio probe', async () => {
  const { web: webAudio } = createAudioProbeRuntimeHost({ host: createTestHostEnvironment() });
  expect(await webAudio.resolve(web)).toBeUndefined();

  const actions: string[] = [];
  const query: AudioProbeQueryInput = { action: 'status', durationMs: 1000, bucketMs: 100 };
  await withWebProvider(
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
