import http from 'node:http';
import { vi } from 'vitest';
import { startDaemonRuntime, type DaemonRuntimeDeps } from '@agent-device/daemon';
import { createCommandSurfaceAgentDevice } from '@agent-device/command-runtime';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { createOwnedProcessRecordStore } from '@agent-device/host-kit/process';
import { getRequestSignal, markRequestCanceled } from '@agent-device/host-kit/request';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import {
  ANDROID_EMULATOR,
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createDaemonPlatformServices } from './platform-runtime-daemon-services.ts';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let deviceIndex = 0;

export async function route() {
  const device = { ...ANDROID_EMULATOR, id: `android-http-readiness-${++deviceIndex}` };
  const captureSnapshot = vi.fn(async () => ({
    nodes: [],
    backend: 'android' as const,
    producer: 'android-uiautomator' as const,
  }));
  const readClipboard = vi.fn(async () => 'ready clipboard');
  const unexpected = vi.fn(async () => {
    throw new Error('readiness route dispatched before Android readiness');
  });
  const owner = localRuntimeOwner('android');
  const facts = (target: DeviceInfo) => {
    const base = createUnavailableRuntimeFactsForTest(target, owner);
    return {
      ...base,
      operations: {
        ...base.operations,
        captureSnapshot: { available: true as const },
        captureSnapshotWithoutActiveApp: { available: true as const },
        readClipboard: { available: true as const },
        readAlert: { available: true as const },
        readSetting: { available: true as const },
        setSetting: { available: true as const },
        keyboardStatus: { available: true as const },
      },
    };
  };
  const gateway: DaemonRuntimeDeps['deviceRuntimeGateway'] = {
    inspectFacts: async (target) => facts(target),
    bind: async ({ device: target }) => ({
      device: target,
      owner,
      facts: facts(target),
      operations: {
        captureSnapshot,
        captureSnapshotWithoutActiveApp: captureSnapshot,
        readClipboard,
        readAlert: unexpected,
        readSetting: unexpected,
        setSetting: unexpected,
        keyboardStatus: unexpected,
      },
      [Symbol.asyncDispose]: async () => {},
    }),
    shutdown: async () => {},
    applicationLifecycle: {
      recoverStartupResources: async () => {},
      detachForDaemonShutdown: async () => [],
      finalizeDaemonShutdown: async () => [],
    },
  };
  const stateDir = mkdtempForTestSync('android-readiness-http-runtime-');
  const daemon = await startDaemonRuntime({
    ownership: 'embedded',
    host: createTestHostEnvironment({
      env: {
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      },
    }),
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    composeDeps: async (input) => ({
      ownedProcessRecords: createOwnedProcessRecordStore({
        stateDir: input.baseDir,
        sessionsDir: input.sessionsDir,
        resolveSessionDir: input.resolveSessionDir,
      }),
      hostDiagnostics: {
        toolchainCheck: async () => undefined,
        deviceChecks: async () => [],
        ambientChecks: async () => [],
        warmupCheck: async () => undefined,
      },
      ownerLifecycle: {
        configureForDaemonLock: async () => {},
        clearDaemonLockConfiguration: async () => {},
        recoverLegacyAppLogMarkers: async () => ({ recovered: [], retained: [] }),
        cleanupManagedWebOrphans: async () => {},
        resetAndroidSnapshotHelper: async () => {},
      },
      shutdownProviderRuntimes: async () => [],
      pluginInventory: [],
      providerRuntimeIds: [],
      recoverableProviderIds: [],
      deviceRuntimeGateway: gateway,
      platformResourceCleanup: {
        stopSnapshotHelper: async () => {},
        closeManagedBrowser: async () => {},
        cleanupSessionlessExecutionHost: async () => {},
        retainExecutionHostAfterClose: () => false,
      },
      claimRecoveryGateway: () => gateway,
      interactorResolution: {
        resolve: async () => {
          throw new Error('readiness route must use its admitted runtime');
        },
      },
      providerDeviceAdmission: { isActive: () => false },
      cleanupManagedWebOrphans: async () => {},
      requestRouter: {
        deviceInventoryGateways: createTestDeviceInventoryGateways({ local: async () => [device] }),
        platformServices: createDaemonPlatformServices(),
        androidObservation: {
          readAppState: async () => ({}),
          readBlockingDialog: async () => ({ status: 'clear' }),
          readAppFocus: async () => true,
          readSnapshotNodes: async () => [],
          tap: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
          openApp: async () => {},
          readScreenSize: async () => ({ width: 1080, height: 1920 }),
          isPermissionPackage: async () => false,
        },
        providerCredentials: { stateDir: input.baseDir, fingerprint: () => undefined },
        createCommandSurface: async (config) => createCommandSurfaceAgentDevice(config),
      },
    }),
  });
  if (!daemon.httpPort) throw new Error('readiness fixture did not start its HTTP runtime');
  let requestIndex = 0;
  function send(
    command: string,
    bounded = false,
    followingCommands: readonly ('snapshot' | 'clipboard')[] = [],
    positionals = command === 'clipboard' ? ['read'] : [],
  ) {
    const requestId = `readiness-${deviceIndex}-${++requestIndex}`;
    const step = {
      command,
      positionals,
      flags: { platform: 'android', serial: device.id },
    };
    const closed = deferred<void>();
    const answer = deferred<DaemonResponse>();
    const request = http.request(
      {
        host: '127.0.0.1',
        port: daemon.httpPort,
        path: '/rpc',
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            result?: DaemonResponse;
            error?: { data: Extract<DaemonResponse, { ok: false }>['error'] };
          };
          answer.resolve(body.result ?? { ok: false, error: body.error!.data });
        });
      },
    );
    request.on('error', () => closed.resolve());
    request.on('close', () => closed.resolve());
    request.setTimeout(1_000, () =>
      request.destroy(new Error('HTTP readiness request did not settle')),
    );
    request.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'agent_device.command',
        params: {
          ...(bounded
            ? {
                command: 'batch',
                flags: {
                  batchSteps: [
                    step,
                    ...followingCommands.map((next) => ({
                      ...step,
                      command: next,
                      positionals: next === 'clipboard' ? ['read'] : [],
                    })),
                  ],
                },
              }
            : step),
          meta: { requestId },
        },
      }),
    );
    return {
      request,
      closed: closed.promise,
      answer: answer.promise,
      cancel: async (disconnect: boolean) => {
        const signal = daemon.run(() => getRequestSignal(requestId));
        if (!signal) throw new Error('HTTP request cancellation was not registered');
        const canceled = new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        if (disconnect) request.destroy();
        else daemon.run(() => markRequestCanceled(requestId));
        await canceled;
        return signal;
      },
    };
  }
  return {
    server: {
      close: async () => {
        await daemon.close();
      },
    },
    send,
    runtime: { captureSnapshot },
    readClipboard,
    unexpected,
  };
}
