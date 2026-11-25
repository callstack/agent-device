import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { screenshotCommandSurface } from '../../__tests__/support/screenshot-command-surface-fake.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';
import { successfulData, withHttp } from './http-output.fixtures.ts';

test('trusted remote suites with a repeated request ID download distinct archives', async () => {
  const root = mkdtempForTestSync('trusted-remote-suite-');
  const scriptPath = path.join(root, 'flow.ad');
  const sessionStore = makeSessionStore('trusted-remote-suite-session-');
  const handler = createRequestHandler({
    host: createTestHostEnvironment({ cwd: root, env: {} }),
    createCommandSurface: screenshotCommandSurface,
    logPath: path.join(root, 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact,
  });
  await withHttp(handler, async (post, base) => {
    const run = async (marker: string) => {
      const source = `# ${marker}\ncontext platform=android\nwait 0\n`;
      const data = successfulData(
        await post(
          {
            command: 'test',
            session: 'capture',
            positionals: [scriptPath],
            flags: {
              replayScriptSources: [{ entry: scriptPath, files: { [scriptPath]: source } }],
            },
            meta: {
              requestId: 'repeat-request',
              clientArtifactPaths: { artifactsDir: '/client/downloads' },
            },
          },
          false,
        ),
      );
      expect(data.executed).toBe(1);
      return data.artifacts![0]!.artifactId!;
    };
    const first = await run('first-archive-only');
    const second = await run('second-archive-only');
    try {
      expect(first).not.toBe(second);
      for (const [id, wanted, unwanted] of [
        [first, 'first-archive-only', 'second-archive-only'],
        [second, 'second-archive-only', 'first-archive-only'],
      ] as const) {
        const response = await fetch(`${base}/artifacts/${id}`, {
          headers: { authorization: 'Bearer test-token' },
        });
        expect(response.status).toBe(200);
        const archive = gunzipSync(Buffer.from(await response.arrayBuffer()));
        expect(archive.includes(Buffer.from(wanted))).toBe(true);
        expect(archive.includes(Buffer.from(unwanted))).toBe(false);
      }
    } finally {
      cleanupDownloadableArtifact(first);
      cleanupDownloadableArtifact(second);
    }
  });
});
