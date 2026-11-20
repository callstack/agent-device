import { makeWebProvider, webSelectionFixture } from './platform-runtime-web-provider.fixtures.ts';
import { expect, test } from 'vitest';
import { resolveWebScreenRecordingTransport } from './platform-runtime-screen-recording-web-host.ts';

const web = {
  platform: 'web' as const,
  id: 'browser',
  name: 'Browser',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

const webPlugin = webSelectionFixture();

test('never falls back to an unscoped local web recorder', async () => {
  expect(await resolveWebScreenRecordingTransport(web, webPlugin)).toBeUndefined();
  const calls: string[] = [];
  await webPlugin.get().withRequestProvider(
    makeWebProvider({
      startRecording: async (outputPath) => {
        calls.push(`start:${outputPath}`);
      },
      stopRecording: async () => {
        calls.push('stop');
      },
    }),
    async () => {
      const transport = await resolveWebScreenRecordingTransport(web, webPlugin);
      if (!transport) throw new Error('missing scoped web recording transport');
      await transport.start('/tmp/capture.webm');
      await transport.stop();
    },
  );
  expect(calls).toEqual(['start:/tmp/capture.webm', 'stop']);
});
