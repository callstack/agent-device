import fs from 'node:fs';
import net from 'node:net';
import { expect, test, vi } from 'vitest';
import { startDaemonRuntime } from '@agent-device/daemon';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { readDaemonStopIdentity } from '@agent-device/daemon-contracts/daemon-registration';
import { resolveDaemonShutdownReportPath } from '@agent-device/daemon-contracts/daemon-shutdown-report';
import { isProcessAlive } from '@agent-device/host-kit/process';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createDaemonRuntimeDeps } from './daemon-composition.ts';
import { readDaemonInfo } from './daemon-client/daemon-client-metadata.ts';
import { stopRecordedDaemon } from './daemon-client/daemon-client-stop.ts';
import * as transport from './daemon-client/daemon-client-transport.ts';

const closeStep = vi.hoisted(() => ({
  gate: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
}));
vi.mock('./platform-runtime.ts', () => ({
  androidObservation: {},
  createRequestPlatformProviders: () => ({
    run: async (_: unknown, task: () => Promise<unknown>) => await task(),
  }),
  createPlatformDeviceInventoryGateways: () => ({}),
  createPlatformRuntimeGateway: () => ({
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => [],
      finalizeDaemonShutdown: async () => [],
    },
    inspectFacts: async () => {
      throw new Error('unused');
    },
    bind: async () => {
      throw new Error('unused');
    },
    shutdown: async () => {
      closeStep.entered?.();
      await closeStep.gate;
      return [];
    },
  }),
}));
vi.mock('./provider-device-runtimes.ts', () => ({
  createDaemonProviderRuntimeComposition: async () => ({
    runtimes: [],
    platformModules: [],
    shutdown: async () => [],
    inventory: [],
  }),
}));

test('two stops after direct host close loses its listener receive its released cleanup', async () => {
  const stateDir = mkdtempForTestSync('agent-device-direct-released-');
  const paths = resolveDaemonPaths(stateDir);
  const host = createTestHostEnvironment({
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
    },
  });
  let release = () => {};
  closeStep.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    closeStep.entered = resolve;
  });
  const runtime = await startDaemonRuntime({
    host,
    ownership: 'embedded',
    composeDeps: createDaemonRuntimeDeps,
    shutdownBudgets: { ownerMs: 10_000 },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
  });
  const info = readDaemonInfo(paths.infoPath)!;
  const original = fs.readFileSync(paths.infoPath, 'utf8');
  const signals = vi.spyOn(process, 'kill');
  const closing = runtime.close();
  try {
    await entered;
    await expect(
      new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port: info.httpPort! });
        socket.on('connect', () => {
          socket.destroy();
          resolve('still listening');
        });
        socket.on('error', reject);
      }),
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe(original);
    const failures: unknown[] = [];
    const send = transport.sendRequest;
    vi.spyOn(transport, 'sendRequest').mockImplementation(async (...args) => {
      try {
        return await send(...args);
      } catch (error) {
        failures.push(error);
        throw error;
      }
    });
    let settled = 0;
    const started = Date.now();
    const stops = [0, 1].map(() =>
      stopRecordedDaemon(readDaemonStopIdentity(paths.infoPath), { paths, host }).then((result) => {
        settled++;
        return result;
      }),
    );
    await vi.waitFor(() => expect(failures).toHaveLength(2));
    for (const failure of failures)
      expect(failure).toMatchObject({ details: { reason: 'daemon_transport_failure' } });
    expect(settled).toBe(0);
    expect(fs.readFileSync(paths.infoPath, 'utf8')).toBe(original);
    release();
    const report = await closing;
    const results = await Promise.all(stops);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(report).toMatchObject({ requests: { abandoned: 0 }, providerReleases: { pending: [] } });
    for (const result of results)
      expect(result).toMatchObject({
        stopped: true,
        mode: 'graceful',
        cleanupConfidence: 'known',
        warnings: [],
        providerReleases: { status: 'completed', released: [], pending: [] },
      });
    expect(
      JSON.parse(fs.readFileSync(resolveDaemonShutdownReportPath(stateDir), 'utf8')).completion,
    ).toMatchObject({
      token: info.token,
      pid: info.pid,
      processStartTime: info.processStartTime,
      outcome: 'released',
      unfinished: [],
    });
    expect(fs.existsSync(paths.infoPath)).toBe(false);
    expect(fs.existsSync(paths.lockPath)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(signals.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([]);
  } finally {
    release();
    await closing;
    vi.restoreAllMocks();
    closeStep.gate = undefined;
    closeStep.entered = undefined;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
