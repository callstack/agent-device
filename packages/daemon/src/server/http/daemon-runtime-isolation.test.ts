import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { daemonRuntimeDepsFixture } from '../../__tests__/support/daemon-runtime-deps-fixture.ts';
import { interactorResolution } from '../../core/interactor-resolution.ts';
import { isActiveProviderDevice } from '../../core/provider-device-admission.ts';
import { trackDownloadableArtifact } from '../../resources/artifact-tracking.ts';
import { startDaemonRuntime } from './daemon-runtime.ts';

async function startIsolatedRuntime(label: string, interactorTag: string, providerActive: boolean) {
  const stateDir = mkdtempForTestSync(`agent-device-daemon-isolation-${label}-`);
  const runtime = await startDaemonRuntime({
    host: createTestHostEnvironment({
      env: {
        ...process.env,
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    }),
    stderr: { write: () => {} },
    stdout: { write: () => {} },
    composeDeps: daemonRuntimeDepsFixture({
      interactorResolution: Object.freeze({
        resolve: async () => {
          throw new Error(interactorTag);
        },
      }),
      providerDeviceAdmission: Object.freeze({ isActive: () => providerActive }),
    }),
  });
  const { httpPort, token } = JSON.parse(
    fs.readFileSync(resolveDaemonPaths(stateDir).infoPath, 'utf8'),
  ) as { httpPort: number; token: string };
  return { runtime, stateDir, httpPort, token };
}

async function callSessionList(httpPort: number, token: string, requestId: string) {
  const response = await fetch(`http://127.0.0.1:${httpPort}/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      method: 'agent_device.command',
      params: { command: 'session_list', meta: { requestId } },
    }),
  });
  return (await response.json()) as { result?: unknown; error?: unknown };
}

test('two runtimes in one process serve, close and keep their state independently', async () => {
  let a: Awaited<ReturnType<typeof startIsolatedRuntime>> | undefined;
  let b: Awaited<ReturnType<typeof startIsolatedRuntime>> | undefined;
  try {
    a = await startIsolatedRuntime('a', 'interactor-a', true);
    b = await startIsolatedRuntime('b', 'interactor-b', false);
    expect(a.httpPort).not.toBe(b.httpPort);
    expect(path.basename(a.stateDir)).not.toBe(path.basename(b.stateDir));

    // Each runtime answers requests with its own token and its own state dir.
    expect((await callSessionList(a.httpPort, a.token, 'iso-a-1')).error).toBeUndefined();
    expect((await callSessionList(b.httpPort, b.token, 'iso-b-1')).error).toBeUndefined();

    // Per-runtime state: what one installs or tracks is invisible to the other.
    expect(a.runtime.run(() => isActiveProviderDevice({} as never))).toBe(true);
    expect(b.runtime.run(() => isActiveProviderDevice({} as never))).toBe(false);
    await expect(
      a.runtime.run(() => interactorResolution().resolve({} as never, {})),
    ).rejects.toThrow('interactor-a');
    await expect(
      b.runtime.run(() => interactorResolution().resolve({} as never, {})),
    ).rejects.toThrow('interactor-b');

    const artifactPath = path.join(a.stateDir, 'artifact.txt');
    fs.writeFileSync(artifactPath, 'artifact-a');
    const artifactId = a.runtime.run(() =>
      trackDownloadableArtifact({
        artifactPath,
        artifactType: 'runtime-artifact',
        fileName: 'artifact.txt',
      }),
    );
    const fromB = await fetch(
      `http://127.0.0.1:${b.httpPort}/artifacts/${encodeURIComponent(artifactId)}`,
      { headers: { authorization: `Bearer ${b.token}`, connection: 'close' } },
    );
    expect(fromB.status).not.toBe(200);
    await fromB.text();

    // Closing one runtime leaves the other serving.
    const reportA = await a.runtime.close();
    expect(reportA.sessions).toEqual({ closed: 0, failed: 0 });
    await expect(callSessionList(a.httpPort, a.token, 'iso-a-2')).rejects.toThrow();
    expect((await callSessionList(b.httpPort, b.token, 'iso-b-2')).error).toBeUndefined();
    expect(b.runtime.run(() => isActiveProviderDevice({} as never))).toBe(false);

    const reportB = await b.runtime.close();
    expect(reportB.plugins).toEqual({ disposed: [], failed: [], pending: [] });
  } finally {
    await a?.runtime.close();
    await b?.runtime.close();
  }
});
