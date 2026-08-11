import { expect, test } from 'vitest';
import { createAppleScreenRecordingHost } from './platform-runtime-screen-recording-apple-host.ts';
import { withAppleRunnerScreenRecordingTransport } from './platform-runtime-screen-recording-apple-runner-transport.ts';
import { withAppleSimulatorScreenRecordingTransport } from './platform-runtime-screen-recording-apple-transport.ts';

const simulator = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'sim',
  name: 'Simulator',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
};
const device = { ...simulator, id: 'device', kind: 'device' as const };

test('reports unavailable facts for generic scoped Apple providers', async () => {
  const host = createAppleScreenRecordingHost();
  await withAppleRunnerScreenRecordingTransport(undefined, async () => {
    await expect(host.availability(device)).resolves.toMatchObject({ available: false });
  });
  await withAppleSimulatorScreenRecordingTransport(undefined, async () => {
    await expect(host.availability(simulator)).resolves.toMatchObject({ available: false });
  });
});

test('reports a focused simulator transport as available', async () => {
  const host = createAppleScreenRecordingHost();
  await withAppleSimulatorScreenRecordingTransport(
    {
      available: true,
      mode: 'transport-composed',
      start: async () => {
        throw new Error('unused');
      },
    },
    async () => {
      await expect(host.availability(simulator)).resolves.toEqual({ available: true });
    },
  );
});
