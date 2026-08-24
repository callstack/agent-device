import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { test, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequestHandler } from './test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import type { DaemonArtifactInventoryEntry } from '@agent-device/contracts/observability';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeSession } from '../../__tests__/test-utils/session-factories.ts';
import { WEB_DESKTOP_DEVICE } from '../../__tests__/test-utils/device-fixtures.ts';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { cleanupDownloadableArtifact, trackDownloadableArtifact } from '../artifact-tracking.ts';

// #1900: `artifacts` (`handlers/lease.ts`) lists daemon-tracked artifacts by tenant scope with no
// device or platform involvement at all — `listArtifactsForRequest` never reads `device.platform`.
// This proves the command actually resolves and lists an artifact end to end for a session whose
// device is web, the same round trip `request-router-events.test.ts` already proves for `events`.
test('artifacts lists a daemon-tracked artifact produced during a web session', async () => {
  const sessionStore = makeSessionStore('agent-device-router-artifacts-web-');
  sessionStore.set('web-session', makeSession('web-session', { device: WEB_DESKTOP_DEVICE }));
  const artifactDir = mkdtempForTestSync('agent-device-router-artifacts-web-file-');
  const artifactPath = path.join(artifactDir, 'web-smoke.png');
  fs.writeFileSync(artifactPath, 'fixture-bytes');
  const artifactId = trackDownloadableArtifact({
    artifactPath,
    artifactType: 'screenshot',
    fileName: 'web-smoke.png',
  });

  try {
    const handler = createRequestHandler({
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      token: 'test-token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      trackDownloadableArtifact: () => 'unused-artifact-id',
    });

    const response = await handler({
      token: 'test-token',
      session: 'web-session',
      command: 'artifacts',
      positionals: [],
      flags: {},
      meta: { requestId: 'req-artifacts-web' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data?.source).toBe('daemon');
    expect(response.data?.status).toBe('ready');
    const artifacts = response.data?.artifacts as unknown as DaemonArtifactInventoryEntry[];
    expect(
      artifacts.some(
        (artifact) => artifact.id === artifactId && artifact.filename === 'web-smoke.png',
      ),
    ).toBe(true);
  } finally {
    cleanupDownloadableArtifact(artifactId);
  }
});
