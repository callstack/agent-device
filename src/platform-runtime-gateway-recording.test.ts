import path from 'node:path';
import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createPlatformRuntimeGateway } from './platform-runtime.ts';

const unsupportedRecordingDevices = [
  {
    platform: 'linux',
    id: 'linux-desktop',
    name: 'Linux desktop',
    kind: 'device',
    target: 'desktop',
  },
  { platform: 'vega', id: 'vega-tv', name: 'Vega', kind: 'device', target: 'tv' },
] satisfies readonly DeviceInfo[];

test.each(unsupportedRecordingDevices)(
  'the composed $platform runtime reports screen recording as unavailable',
  async (device) => {
    const sessionsDir = mkdtempForTestSync('platform-runtime-recording-');
    const gateway = createPlatformRuntimeGateway({
      env: process.env,
      sessionsDir,
      resolveSessionArtifacts: (sessionId) => ({
        outputPath: path.join(sessionsDir, sessionId, 'app.log'),
        pidPath: path.join(sessionsDir, sessionId, 'app-log.pid'),
      }),
    });

    try {
      const facts = await gateway.inspectFacts(device);

      expect(facts.operations.screenRecordingStart).toEqual({
        available: false,
        reason: 'unsupported-platform-leaf',
      });
    } finally {
      await gateway.shutdown();
    }
  },
);
