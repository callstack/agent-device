import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { test, expect } from 'vitest';
import fs from 'node:fs';

import path from 'node:path';
import { createRequestHandler } from '../../__tests__/support/test-device-runtime-gateway.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { DaemonArtifactInventoryEntry } from '@agent-device/contracts/observability';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeSession } from '../../__tests__/support/session-factories.ts';
import {
  mkdtempForTestSync,
  WEB_DESKTOP_DEVICE,
  createTestHostEnvironment,
} from '@agent-device/test-kit';

import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';

// #1900: `artifacts` (`handlers/lease.ts`) lists daemon-tracked artifacts by tenant scope with no
// device or platform involvement at all — `listArtifactsForRequest` never reads `device.platform`.
// This proves the command actually resolves and lists an artifact end to end for a session whose
// device is web, the same round trip `request-router-events.test.ts` already proves for `events`.
test('artifacts lists a daemon-tracked artifact produced during a web session', async () => {
  const sessionStore = makeSessionStore('agent-device-router-artifacts-web-');
  sessionStore.publish('web-session', makeSession('web-session', { device: WEB_DESKTOP_DEVICE }));
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
      host: createTestHostEnvironment(),
      createCommandSurface: fakeCreateCommandSurface,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
