import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import type { ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type {
  DeviceRuntimeGateway,
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
  PlatformRuntimeProviderModule,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { handleAppDeploymentCommand } from '../../../src/daemon/handlers/session-app-deployment.ts';
import { createRequestRuntimeBindings } from '../../../src/daemon/request-runtime-binding.ts';
import { makeSessionStore } from '../../../src/__tests__/test-utils/store-factory.ts';
import { mkdtempForTestSync } from '../../../src/__tests__/test-utils/tmp-dir.ts';
import { createComposedPlatformRuntimeGateway } from '../../../src/platform-runtime-gateway.ts';

function createProviderDeploymentAdmission(params: {
  runtime: ProviderDeviceRuntime;
  module: PlatformRuntimeProviderModule;
  device: DeviceInfo;
}) {
  const localLoad = vi.fn(async () => {
    throw new Error('provider-owned device must not load a local runtime');
  });
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map([['android', { family: 'android', loadRuntime: localLoad }]]),
    loadHost: async () => ({}) as PlatformRuntimeHost,
    providerRuntimes: [params.runtime],
    providerModules: [{ runtime: params.runtime, module: params.module }],
  });
  let inspectedFacts: RuntimeFacts<PlatformRuntimeOperations> | undefined;
  const inspectFacts = vi.fn(async (device: DeviceInfo) => {
    inspectedFacts = await gateway.inspectFacts(device);
    return inspectedFacts;
  });
  const bind = vi.fn(
    async (...args: Parameters<DeviceRuntimeGateway<PlatformRuntimeOperations>['bind']>) =>
      await gateway.bind(...args),
  );
  const bindings = createRequestRuntimeBindings({
    gateway: { inspectFacts, bind, shutdown: async () => {} },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
    admitDeviceClaim: async () => {},
  });
  return {
    bindings,
    inspectFacts,
    bind,
    localLoad,
    facts: () => inspectedFacts,
    close: async () => {
      await bindings[Symbol.asyncDispose]();
      await gateway.shutdown();
    },
  };
}

export async function inspectProviderDeploymentAdmission(params: {
  runtime: ProviderDeviceRuntime;
  module: PlatformRuntimeProviderModule;
  device: DeviceInfo;
}) {
  const admission = createProviderDeploymentAdmission(params);
  const sessionStore = makeSessionStore('agent-device-provider-admission-');
  const appDirectory = mkdtempForTestSync('agent-device-provider-app-');
  const appPath = path.join(appDirectory, 'demo.apk');
  fs.writeFileSync(appPath, 'fixture');

  try {
    sessionStore.set('default', {
      name: 'default',
      createdAt: 1,
      actions: [],
      device: params.device,
    });
    const response = await handleAppDeploymentCommand({
      req: {
        token: 'test',
        session: 'default',
        command: 'install',
        positionals: [appPath],
        flags: {},
      },
      command: 'install',
      sessionName: 'default',
      sessionStore,
      inspectFacts: admission.bindings.inspectFacts,
      bindDevice: admission.bindings.bindDevice,
    });
    const facts = admission.facts();
    if (!facts) throw new Error('Expected provider facts inspection');
    return {
      response,
      facts,
      inspectFactCalls: admission.inspectFacts.mock.calls.length,
      bindCalls: admission.bind.mock.calls.length,
      localLoadCalls: admission.localLoad.mock.calls.length,
    };
  } finally {
    await admission.close();
    fs.rmSync(appDirectory, { recursive: true, force: true });
  }
}
