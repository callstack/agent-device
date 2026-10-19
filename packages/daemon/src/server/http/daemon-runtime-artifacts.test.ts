import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import {
  cleanupDownloadableArtifact,
  trackDownloadableArtifact,
} from '../../resources/artifact-tracking.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

async function downloadTrackedArtifact(env: Record<string, string>, awaitConsumption: boolean) {
  const stateDir = mkdtempForTestSync('agent-device-daemon-runtime-artifacts-');
  const artifactPath = path.join(stateDir, 'runtime-artifact.txt');
  fs.writeFileSync(artifactPath, 'runtime-artifact');
  const runtime = await startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        ...env,
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
    composeDeps: daemonRuntimeDepsFixture(),
  });
  const artifactId = runtime.run(() =>
    trackDownloadableArtifact({
      artifactPath,
      artifactType: 'runtime-artifact',
      fileName: 'runtime-artifact.txt',
    }),
  );
  try {
    const response = await fetch(
      `http://127.0.0.1:${runtime?.httpPort}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: { authorization: `Bearer ${runtime?.token}`, connection: 'close' } },
    );
    const body = await response.text();
    if (awaitConsumption) {
      for (let attempt = 0; attempt < 20 && fs.existsSync(artifactPath); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    return { status: response.status, body, onDisk: fs.existsSync(artifactPath) };
  } finally {
    runtime.run(() => cleanupDownloadableArtifact(artifactId));
    await runtime.close();
  }
}

test('AGENT_DEVICE_RETAIN_ARTIFACTS keeps a downloaded artifact on disk', async () => {
  const download = await downloadTrackedArtifact({ AGENT_DEVICE_RETAIN_ARTIFACTS: '1' }, false);

  expect(download.status).toBe(200);
  expect(download.body).toBe('runtime-artifact');
  expect(download.onDisk).toBe(true);
});

test('a downloaded artifact is consumed when the daemon was not told to retain artifacts', async () => {
  const download = await downloadTrackedArtifact({ AGENT_DEVICE_RETAIN_ARTIFACTS: '' }, true);

  expect(download.status).toBe(200);
  expect(download.body).toBe('runtime-artifact');
  expect(download.onDisk).toBe(false);
});
