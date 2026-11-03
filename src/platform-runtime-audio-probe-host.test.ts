import { expect, test } from 'vitest';
import { withWebProvider } from '@agent-device/platform-web';
import { createTestHostEnvironment } from '@agent-device/test-kit';
import { createAudioProbeRuntimeHost } from './platform-runtime-audio-probe-host.ts';

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
  await withWebProvider(
    {
      probeAudio: async (options: { action: string }) => {
        actions.push(options.action);
        return {};
      },
    } as never,
    async () => {
      const transport = await webAudio.resolve(web);
      if (!transport) throw new Error('missing scoped web audio transport');
      await transport.probe({ action: 'status' } as never);
    },
  );
  expect(actions).toEqual(['status']);
});
