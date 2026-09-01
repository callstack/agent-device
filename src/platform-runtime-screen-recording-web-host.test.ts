import { expect, test } from 'vitest';
import { withWebProvider } from '@agent-device/platform-web';
import { resolveWebScreenRecordingTransport } from './platform-runtime-screen-recording-web-host.ts';

const web = {
  platform: 'web' as const,
  id: 'browser',
  name: 'Browser',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

test('never falls back to an unscoped local web recorder', async () => {
  expect(await resolveWebScreenRecordingTransport(web)).toBeUndefined();
  const calls: string[] = [];
  await withWebProvider(
    {
      startRecording: async (outputPath: string) => calls.push(`start:${outputPath}`),
      stopRecording: async () => calls.push('stop'),
    } as never,
    async () => {
      const transport = await resolveWebScreenRecordingTransport(web);
      if (!transport) throw new Error('missing scoped web recording transport');
      await transport.start('/tmp/capture.webm');
      await transport.stop();
    },
  );
  expect(calls).toEqual(['start:/tmp/capture.webm', 'stop']);
});
