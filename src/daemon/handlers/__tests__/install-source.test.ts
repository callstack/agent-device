import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
  screenshotRuntimeOperationFacts,
  snapshotRuntimeOperationFacts,
  type AppDeploymentResult,
  type DeviceBinding,
  type MaterializedAppSource,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { unavailableApplicationLifecycleOperationFacts } from '../../../__tests__/test-utils/runtime-operation-facts.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, SessionState } from '../../types.ts';
import { handleInstallFromSourceDeploymentCommand } from '../session-app-source-deployment.ts';

type SourceRuntimeOptions = Readonly<{
  materializationAvailable?: boolean;
  readinessAvailable?: boolean;
  providerMode?: RuntimeFacts<PlatformRuntimeOperations>['device']['providerMode'];
}>;

function makeStore(): SessionStore {
  return new SessionStore(
    path.join(mkdtempForTestSync('agent-device-install-source-'), 'sessions'),
  );
}

function makeSession(device: DeviceInfo): SessionState {
  return { name: 'default', createdAt: Date.now(), actions: [], device };
}

function makeRequest(source: NonNullable<DaemonRequest['meta']>['installSource']): DaemonRequest {
  return {
    token: 't',
    session: 'default',
    command: 'install_source',
    positionals: [],
    flags: {},
    meta: { installSource: source },
  };
}

test('install_source materializes and deploys through one admitted runtime binding', async () => {
  const store = makeStore();
  const session = makeSession({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  store.set(session.name, session);
  const materialize = vi.fn(
    async (): Promise<MaterializedAppSource> => ({
      installablePath: '/tmp/materialized/app.apk',
      cleanup: async () => {},
    }),
  );
  const deploy = vi.fn(
    async (): Promise<AppDeploymentResult> => ({
      packageName: 'com.example.app',
      appName: 'App',
      launchTarget: 'com.example.app',
    }),
  );
  const runtime = createSourceRuntime(session.device, materialize, deploy);

  const response = await handleInstallFromSourceDeploymentCommand({
    req: makeRequest({ kind: 'url', url: 'https://example.com/app.zip', headers: {} }),
    sessionName: session.name,
    sessionStore: store,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response).toEqual({
    ok: true,
    data: {
      packageName: 'com.example.app',
      appName: 'App',
      launchTarget: 'com.example.app',
      message: 'Installed: App',
    },
  });
  expect(runtime.inspectFacts).toHaveBeenCalledOnce();
  expect(runtime.bindCalls).toHaveBeenCalledOnce();
  expect(runtime.bindCalls.mock.calls[0]?.[1]).toMatchObject({
    required: ['ensureReady', 'materializeAppSource', 'deployMaterializedApp'],
  });
  expect(runtime.ensureReady).toHaveBeenCalledOnce();
  expect(materialize).toHaveBeenCalledOnce();
  expect(deploy).toHaveBeenCalledOnce();
});

test('install_source rejects unavailable facts before binding or materializing', async () => {
  const store = makeStore();
  const session = makeSession({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  store.set(session.name, session);
  const materialize = vi.fn(
    async (): Promise<MaterializedAppSource> => ({
      installablePath: '/tmp/materialized/app.apk',
      cleanup: async () => {},
    }),
  );
  const runtime = createSourceRuntime(session.device, materialize, async () => ({}), {
    materializationAvailable: false,
  });

  const response = await handleInstallFromSourceDeploymentCommand({
    req: makeRequest({ kind: 'url', url: 'https://example.com/app.zip' }),
    sessionName: session.name,
    sessionStore: store,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', details: { reason: 'owner-capability-missing' } },
  });
  expect(runtime.inspectFacts).toHaveBeenCalledOnce();
  expect(runtime.bindCalls).not.toHaveBeenCalled();
  expect(runtime.ensureReady).not.toHaveBeenCalled();
  expect(materialize).not.toHaveBeenCalled();
});

test('install_source fails closed when a provider owner does not expose readiness', async () => {
  const store = makeStore();
  const session = makeSession({
    platform: 'android',
    id: 'provider:android:lease-a',
    name: 'Provider Android',
    kind: 'emulator',
    booted: true,
  });
  store.set(session.name, session);
  const localMaterialization = vi.fn(
    async (): Promise<MaterializedAppSource> => ({
      installablePath: '/tmp/local-fallback.apk',
      cleanup: async () => {},
    }),
  );
  const runtime = createSourceRuntime(session.device, localMaterialization, async () => ({}), {
    providerMode: 'provider-runtime',
    readinessAvailable: false,
  });

  const response = await handleInstallFromSourceDeploymentCommand({
    req: makeRequest({ kind: 'url', url: 'https://example.com/app.zip' }),
    sessionName: session.name,
    sessionStore: store,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', details: { reason: 'owner-capability-missing' } },
  });
  expect(runtime.inspectFacts).toHaveBeenCalledOnce();
  expect(runtime.bindCalls).not.toHaveBeenCalled();
  expect(runtime.ensureReady).not.toHaveBeenCalled();
  expect(localMaterialization).not.toHaveBeenCalled();
});

test('deployment handlers use the runtime readiness route without a legacy device-ready adapter', () => {
  const deploymentSources = [
    readFileSync(new URL('../session-app-deployment.ts', import.meta.url), 'utf8'),
    readFileSync(new URL('../session-app-source-deployment.ts', import.meta.url), 'utf8'),
  ].join('\n');

  // Keep all module syntaxes out of this handler family. A legacy adapter import would make
  // provider-owned missing readiness silently fall back to local execution before binding.
  expect(deploymentSources).not.toMatch(
    /(?:\bfrom|\bimport\s*\(|\brequire\s*\()\s*['"][^'"]*device-ready(?:\.ts)?['"]/,
  );
  expect(deploymentSources).not.toMatch(/\bensureDeviceReady\b/);
  expect(deploymentSources).not.toMatch(/ensureReady\s*:\s*true/);
  expect(deploymentSources).not.toMatch(/\brequireCommandSupported\b/);
  expect(deploymentSources).not.toMatch(/\binstallProviderDevice(?:App|InstallablePath)\b/);
  expect(deploymentSources).toContain('readyMaterializeAndDeployAppUse');
  expect(deploymentSources).toContain('readySendPushNotificationUse');
});

test('install_source cleans materialized paths when deployment fails after admission', async () => {
  const store = makeStore();
  const session = makeSession({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  store.set(session.name, session);
  const cleanup = vi.fn(async () => {});
  const runtime = createSourceRuntime(
    session.device,
    async () => ({ installablePath: '/tmp/materialized/app.apk', cleanup }),
    async () => {
      throw new AppError('COMMAND_FAILED', 'provider deployment failed');
    },
  );

  const response = await handleInstallFromSourceDeploymentCommand({
    req: makeRequest({ kind: 'url', url: 'https://example.com/app.zip' }),
    sessionName: session.name,
    sessionStore: store,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response).toMatchObject({ ok: false, error: { code: 'COMMAND_FAILED' } });
  expect(runtime.inspectFacts).toHaveBeenCalledOnce();
  expect(runtime.bindCalls).toHaveBeenCalledOnce();
  expect(runtime.ensureReady).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});

test('install_source preserves the Android identity failure when its runtime cannot resolve one', async () => {
  const store = makeStore();
  const session = makeSession({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  });
  store.set(session.name, session);
  const runtime = createSourceRuntime(
    session.device,
    async () => ({ installablePath: '/tmp/materialized/app.apk', cleanup: async () => {} }),
    async () => ({}),
  );

  const response = await handleInstallFromSourceDeploymentCommand({
    req: makeRequest({ kind: 'url', url: 'https://example.com/app.zip' }),
    sessionName: session.name,
    sessionStore: store,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response).toMatchObject({ ok: false, error: { code: 'COMMAND_FAILED' } });
  if (response.ok) return;
  expect(response.error.message).toMatch(/identity could not be resolved/i);
});

test('install_source returns the typed iOS artifact identity supplied by its runtime', async () => {
  const store = makeStore();
  const session = makeSession({
    platform: 'apple',
    appleOs: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  });
  store.set(session.name, session);
  const runtime = createSourceRuntime(
    session.device,
    async () => ({
      installablePath: '/tmp/AgentDeviceTester.app',
      bundleId: 'com.callstack.agentdevicelab',
      appName: 'Agent Device Tester',
      cleanup: async () => {},
    }),
    async () => ({}),
  );

  const response = await handleInstallFromSourceDeploymentCommand({
    req: makeRequest({ kind: 'path', path: '/tmp/AgentDeviceTester.app' }),
    sessionName: session.name,
    sessionStore: store,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response).toEqual({
    ok: true,
    data: {
      appName: 'Agent Device Tester',
      bundleId: 'com.callstack.agentdevicelab',
      launchTarget: 'com.callstack.agentdevicelab',
      message: 'Installed: Agent Device Tester',
    },
  });
});

function createSourceRuntime(
  device: DeviceInfo,
  materializeAppSource: PlatformRuntimeOperations['materializeAppSource'],
  deployMaterializedApp: PlatformRuntimeOperations['deployMaterializedApp'],
  options: SourceRuntimeOptions = {},
) {
  const facts = sourceRuntimeFacts(device, options);
  const ensureReady = vi.fn(async () => ({ ...device, booted: true }));
  const binding = sourceRuntimeBinding({
    device,
    facts,
    ensureReady,
    materializeAppSource,
    deployMaterializedApp,
  });
  const inspectFacts = vi.fn(async () => facts) satisfies InspectDeviceRuntimeFacts;
  const bindCalls = vi.fn(async (_device, use) => narrowDeviceBinding(binding, use));
  const bindDevice = bindCalls as unknown as BindDeviceRuntime;
  return { inspectFacts, bindDevice, bindCalls, ensureReady };
}

function sourceRuntimeFacts(
  device: DeviceInfo,
  options: SourceRuntimeOptions,
): RuntimeFacts<PlatformRuntimeOperations> {
  const unavailable = Object.freeze({
    available: false,
    reason: 'owner-capability-missing',
  } as const);
  const materializationAvailable = options.materializationAvailable !== false;
  const readinessAvailable = options.readinessAvailable !== false;
  return {
    device: {
      family: device.platform,
      ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      providerMode: options.providerMode ?? 'local',
    },
    operations: {
      ...unavailableApplicationLifecycleOperationFacts,
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: unavailable,
      listApps: unavailable,
      ...snapshotRuntimeOperationFacts({
        capture: unavailable,
        customActions: unavailable,
        withoutActiveApp: unavailable,
      }),
      ...screenshotRuntimeOperationFacts({ capture: unavailable }),
      setViewport: unavailable,
      deployApp: unavailable,
      materializeAppSource: materializationAvailable ? { available: true } : unavailable,
      deployMaterializedApp: materializationAvailable ? { available: true } : unavailable,
      sendPushNotification: unavailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: readinessAvailable ? { available: true } : unavailable,
      bootTarget: unavailable,
      bootTargetHeadless: unavailable,
      shutdownTarget: unavailable,
    },
  };
}

function sourceRuntimeBinding(params: {
  device: DeviceInfo;
  facts: RuntimeFacts<PlatformRuntimeOperations>;
  ensureReady: PlatformRuntimeOperations['ensureReady'];
  materializeAppSource: PlatformRuntimeOperations['materializeAppSource'];
  deployMaterializedApp: PlatformRuntimeOperations['deployMaterializedApp'];
}): DeviceBinding<PlatformRuntimeOperations> {
  const { device, facts, ensureReady, materializeAppSource, deployMaterializedApp } = params;
  return {
    device,
    owner:
      facts.device.providerMode === 'provider-runtime'
        ? providerRuntimeOwner('test-provider', 'lease-a')
        : localRuntimeOwner(device.platform),
    facts,
    operations: {
      ...(facts.operations.ensureReady.available ? { ensureReady } : {}),
      ...(facts.operations.materializeAppSource.available
        ? { materializeAppSource, deployMaterializedApp }
        : {}),
    },
    [Symbol.asyncDispose]: async () => {},
  };
}
