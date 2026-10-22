import path from 'node:path';
import { LeaseRegistry } from '../resources/lease-registry.ts';
import { applicationLifecycleRuntimeFixture } from '../__tests__/support/application-lifecycle-runtime-fixture.ts';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { vi, expect } from 'vitest';
import type { CommandFlags } from '@agent-device/contracts/command';
import { daemonRuntimeDepsFixture } from '../__tests__/support/daemon-runtime-deps-fixture.ts';
import { startDaemonRuntime } from '../server/http/daemon-runtime.ts';
import { createTestDeviceInventoryGatewaysFromProvider } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { SessionStore } from './session-store.ts';
import {
  createUnavailableRuntimeFactsForTest,
  createLiveTestHostEnvironment,
  createTestHostEnvironment,
  mkdtempForTestSync,
  createTestAppLogLiveHandle,
  ANDROID_EMULATOR,
} from '@agent-device/test-kit';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';

export async function resourceAdmissionWorld(
  audioMode: 'capture' | 'query' = 'capture',
  options: Readonly<{
    device?: DeviceInfo;
    providerOwned?: boolean;
    ime?: {
      activate(stateDir: string): Promise<void>;
      restore(stateDir: string): Promise<void>;
      inspect(device: DeviceInfo): readonly string[];
    };
  }> = {},
) {
  const device = options.device ?? ANDROID_EMULATOR;
  let now = 1_000;
  const leaseRegistry = new LeaseRegistry({
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
  });
  const owner = localRuntimeOwner(device.platform);
  const sessionStore = new SessionStore(
    path.join(mkdtempForTestSync('composite-resources-'), 'sessions'),
    createLiveTestHostEnvironment(),
  );
  const ref = sessionStore.publish('resource-session', {
    name: 'resource-session',
    device,
    appBundleId: 'com.android.settings',
    createdAt: Date.now(),
    actions: [],
  });
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const finish = vi.fn(async () => ({
    status: 'completed' as const,
    result: { backend: 'android' as const, outputPath: '/tmp/app.log', completedAt: Date.now() },
  }));
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
    finish,
    forceCleanup,
  });
  const native = vi.fn(async () => {
    throw new Error('resource native effect reached');
  });
  const inspectTeardown = vi.fn(async (target: DeviceInfo) => options.ime?.inspect(target) ?? []);
  const base = createUnavailableRuntimeFactsForTest(device, owner);
  const available = { available: true as const };
  const facts = {
    ...base,
    operations: {
      ...base.operations,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: available,
        prepareApplicationOpen: available,
        openApplication: available,
        closeApplication: available,
        finalizeApplicationClose: available,
        applyRuntimeHints: available,
        clearRuntimeHints: available,
        prepareAppleRunner: available,
        configureProviderPortReverse: available,
      }),
      perfFrames: { available: true as const },
      captureSnapshot: { available: true as const },
      home: { available: true as const },
      perfMemorySample: { available: true as const },
      perfMemorySnapshot: { available: true as const },
      perfNativeCaptureStart: { available: true as const },
      perfNativeCaptureReattach: { available: true as const },
      perfNativeCaptureCleanup: { available: true as const },
      perfProfileReport: { available: true as const },
      setViewport: { available: true as const },
      appLogInspect: { available: true as const },
      appLogDoctor: { available: true as const },
      appLogStart: { available: true as const },
      audioProbeStart:
        audioMode === 'capture'
          ? { available: true as const }
          : { available: false as const, reason: 'owner-capability-missing' as const },
      screenRecordingStart: { available: true as const },
      screenRecordingReattach: { available: true as const },
      screenRecordingCleanup: { available: true as const },
    },
  };
  const sample = vi.fn(async () => ({ metric: { totalPssKb: 42 } }));
  const home = vi.fn(async () => {});
  const setViewport = vi.fn(async () => {});
  const operations: Partial<PlatformRuntimeOperations> = {
    home,
    captureSnapshot: async () => ({ backend: 'xctest', producer: 'apple-runner', nodes: [] }),
    setViewport,
    perfFrames: sample,
    perfMemorySample: sample,
    perfMemorySnapshot: native,
    perfNativeCaptureStart: native,
    perfNativeCaptureReattach: native,
    perfNativeCaptureCleanup: native,
    perfProfileReport: native,
    audioProbeStart: native,
    screenRecordingStart: native,
    screenRecordingReattach: native,
    screenRecordingCleanup: native,
    appLogInspect: async () => ({ backend: 'android' }),
    appLogDoctor: async () => ({ backend: 'android', checks: {}, notes: [] }),
    appLogStart: async (input) =>
      createAppLogStartResult(
        handle,
        createDurableResourceEnvelope({
          resourceKind: 'app-log',
          sessionId: input.sessionId,
          device: deviceIdentity(device),
          owner,
          fence: input.fence,
          lifecycle: 'open',
          descriptor: { version: 1, body: {} },
        }),
      ),
  };
  const bind = vi.fn<DeviceRuntimeGateway<PlatformRuntimeOperations>['bind']>(async ({ scope }) => {
    const lifecycle = await applicationLifecycleRuntimeFixture(device, scope.signal);
    return {
      device,
      owner,
      facts,
      operations: {
        ...operations,
        ...lifecycle,
        openApplication: async (input) => {
          const outcome = await lifecycle.openApplication(input);
          if (input.enableTestIme) await options.ime?.activate(input.stateDir);
          return outcome;
        },
        finalizeApplicationClose: async (input) => {
          await options.ime?.restore(input.stateDir);
          return await lifecycle.finalizeApplicationClose(input);
        },
      },
      [Symbol.asyncDispose]: async () => {},
    };
  });
  const inspectFacts = vi.fn(async () => facts);
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts,
    bind,
    shutdown: async () => {},
  };
  const stateDir = mkdtempForTestSync('resource-admission-http-');
  const host = createTestHostEnvironment({
    env: {
      ...process.env,
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_CLAIMS_DIR: path.join(stateDir, 'claims'),
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
    },
  });
  const runtime = await startDaemonRuntime({
    host,
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    composeDeps: async (input) => {
      const base = await daemonRuntimeDepsFixture()(input);
      return {
        ...base,
        providerDeviceAdmission: Object.freeze({ isActive: () => options.providerOwned === true }),
        deviceRuntimeGateway: {
          ...gateway,
          applicationLifecycle: base.deviceRuntimeGateway.applicationLifecycle,
        },
        requestRouter: {
          ...base.requestRouter,
          sessionStore,
          leaseRegistry,
          platformServices: {
            ...base.requestRouter.platformServices,
            inspectSessionTeardownResources: inspectTeardown,
          },
          deviceInventoryGateways: createTestDeviceInventoryGatewaysFromProvider(async () => [
            device,
          ]),
        },
      };
    },
  });
  let requestNumber = 0;
  const call = async (
    command: string,
    positionals: string[] = [],
    flags: CommandFlags = {},
  ): Promise<ResourceRpcResult> => {
    const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtime.token}`,
        'content-type': 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `resource-${++requestNumber}`,
        method: 'agent_device.command',
        params: { command, positionals, flags, session: 'resource-session' },
      }),
    });
    return { statusCode: response.status, json: await response.json() };
  };
  const daemon = {
    stateDir,
    close: async () => {
      await runtime.close();
    },
  };
  return {
    daemon,
    call,
    sessionStore,
    ref,
    handle,
    finish,
    forceCleanup,
    native,
    inspectTeardown,
    bind,
    inspectFacts,
    sample,
    home,
    setViewport,
    facts,
    leaseRegistry,
    expireLease: () => {
      now = 1_011;
    },
  };
}

type ResourceRpcResult = { statusCode: number; json: any };

export function assertRpcOk(response: ResourceRpcResult): void {
  expect(response.statusCode, JSON.stringify(response.json)).toBe(200);
  expect(response.json.error).toBeUndefined();
}
