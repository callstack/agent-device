import { expect, test } from 'vitest';
import {
  resolveAppleSimulatorScreenRecordingTransport,
  withAppleSimulatorScreenRecordingTransport,
} from './platform-runtime-screen-recording-apple-transport.ts';

const simulator = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'sim',
  name: 'Simulator',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
};

test('scopes an explicit unavailable sentinel instead of falling back to local simctl', async () => {
  await withAppleSimulatorScreenRecordingTransport(undefined, async () => {
    const transport = resolveAppleSimulatorScreenRecordingTransport();
    expect(transport).toMatchObject({ available: false, mode: 'transport-composed' });
    await expect(
      transport.start({ device: simulator, outputPath: '/tmp/capture.mp4' }),
    ).rejects.toThrow('does not expose an Apple simulator screen-recording transport');
  });
});
