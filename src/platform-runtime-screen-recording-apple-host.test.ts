import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createAppleScreenRecordingHost } from './platform-runtime-screen-recording-apple-host.ts';
import { withAppleRunnerScreenRecordingTransport } from './platform-runtime-screen-recording-apple-runner-transport.ts';
import { withAppleSimulatorScreenRecordingTransport } from './platform-runtime-screen-recording-apple-transport.ts';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function isolatedHost() {
  const root = mkdtempForTestSync('apple-recording-scope-');
  roots.push(root);
  return createTestHostEnvironment({
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims') },
  });
}

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
  const host = createAppleScreenRecordingHost(isolatedHost());
  await withAppleRunnerScreenRecordingTransport(undefined, async () => {
    await expect(host.availability(device)).resolves.toMatchObject({ available: false });
  });
  await withAppleSimulatorScreenRecordingTransport(undefined, async () => {
    await expect(host.availability(simulator)).resolves.toMatchObject({ available: false });
  });
});

test('reports a focused simulator transport as available', async () => {
  const host = createAppleScreenRecordingHost(isolatedHost());
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
      await expect(host.cleanupRecoveryScope?.(simulator)).resolves.toBe('unsupported');
    },
  );
});

test('only the local simulator transport advertises drained cleanup recovery', async () => {
  const host = createAppleScreenRecordingHost(isolatedHost());
  await expect(host.cleanupRecoveryScope?.(simulator)).resolves.toBe('local-drained');
  await expect(host.cleanupRecoveryScope?.(device)).resolves.toBe('unsupported');
});
