import path from 'node:path';
import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { PlatformModuleSelection } from '@agent-device/contracts/platform-plugin';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createPlatformRuntimeGateway } from './platform-runtime.ts';
import { vegaPlatformCompositionFixture } from './platform-runtime-vega-provider.fixtures.ts';
import { linuxPlatformCompositionFixture } from './platform-runtime-linux-provider.fixtures.ts';

const unsupportedRecordingDevices = [
  {
    platform: 'linux',
    id: 'linux-desktop',
    name: 'Linux desktop',
    kind: 'device',
    target: 'desktop',
    // Linux is a platform plugin, so this scenario supplies it: the assertion is about what the
    // plugin's runtime reports, not about the builtin family set.
    platforms: linuxPlatformCompositionFixture(),
  },
  {
    platform: 'vega',
    id: 'vega-tv',
    name: 'Vega',
    kind: 'device',
    target: 'tv',
    // Vega is a platform plugin, so this scenario supplies it: the assertion is about what the
    // plugin's runtime reports, not about the builtin family set.
    platforms: vegaPlatformCompositionFixture(),
  },
] satisfies readonly (DeviceInfo & Readonly<{ platforms: PlatformModuleSelection }>)[];

test.each(unsupportedRecordingDevices)(
  'the composed $platform runtime reports screen recording as unavailable',
  async (device) => {
    const sessionsDir = mkdtempForTestSync('platform-runtime-recording-');
    const gateway = createPlatformRuntimeGateway({
      host: createLiveTestHostEnvironment(),
      platforms: device.platforms,
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
