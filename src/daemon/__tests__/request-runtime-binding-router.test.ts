import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
  type PlatformRuntimeOperations,
} from '@agent-device/contracts/platform';
import { createAppLogStartResult, createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createTestAppLogLiveHandle } from '../../__tests__/test-utils/app-log-live-handle.ts';
import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { createRequestHandler } from './test-device-runtime-gateway.ts';

test('request binding disposes once after response while adopted app-log handle survives', async () => {
  const runtime = makeGateway();
  const { handler, sessionStore } = makeHandler(runtime.gateway);
  const response = await handler(request(['start']));

  expect(response).toMatchObject({ ok: true, data: { started: true } });
  expect(runtime.bind).toHaveBeenCalledOnce();
  expect(runtime.bindingDispose).toHaveBeenCalledOnce();
  expect(runtime.forceCleanup).not.toHaveBeenCalled();
  expect(sessionStore.get('session')?.appLog?.handle).toBe(runtime.handle);
});

test('primary request failure survives a rejecting binding disposal', async () => {
  const cleanupFailure = new Error('binding dispose failed');
  const runtime = makeGateway(cleanupFailure);
  const { handler } = makeHandler(runtime.gateway);
  const response = await handler(request(['invalid']));

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: expect.stringContaining('logs requires') },
  });
  expect(runtime.bindingDispose).toHaveBeenCalledOnce();
  if (response.ok || !response.error.logPath) throw new Error('expected request diagnostics path');
  const phases = fs
    .readFileSync(response.error.logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { phase: string }).phase);
  expect(phases).toContain('request_failed');
  expect(phases).toContain('request_binding_cleanup_failed');
});

function makeHandler(gateway: DeviceRuntimeGateway<PlatformRuntimeOperations>) {
  const sessionStore = makeSessionStore('request-runtime-binding-router-');
  sessionStore.set('session', {
    name: 'session',
    device: { platform: 'android', id: 'emulator-5554', name: 'Pixel', kind: 'emulator' },
    appBundleId: 'com.example.app',
    createdAt: Date.now(),
    actions: [],
  });
  return {
    sessionStore,
    handler: createRequestHandler({
      logPath: '/tmp/daemon.log',
      token: 'token',
      sessionStore,
      leaseRegistry: new LeaseRegistry(),
      deviceInventoryGateways: createTestDeviceInventoryGateways(),
      deviceRuntimeGateway: gateway,
      trackDownloadableArtifact: () => 'artifact',
    }),
  };
}

function request(positionals: string[]) {
  return {
    token: 'token',
    session: 'session',
    command: 'logs',
    positionals,
    flags: {},
    meta: { requestId: `logs-${positionals[0]}` },
  };
}

function makeGateway(disposeError?: Error) {
  const owner = localRuntimeOwner('android');
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const handle = createTestAppLogLiveHandle({
    inspect: () => ({ backend: 'android', state: 'active', startedAt: 1 }),
    finish: async () => ({
      status: 'completed',
      result: { backend: 'android', outputPath: '/tmp/app.log', completedAt: 2 },
    }),
    forceCleanup,
  });
  const operations: PlatformRuntimeOperations = {
    appLogInspect: async () => ({ backend: 'android' }),
    appLogDoctor: async () => ({ backend: 'android', checks: {}, notes: [] }),
    appLogStart: async (input) =>
      createAppLogStartResult(
        handle,
        createDurableResourceEnvelope({
          resourceKind: 'app-log',
          sessionId: input.sessionId,
          device: { id: 'emulator-5554', family: 'android', kind: 'emulator' },
          owner,
          fence: input.fence,
          lifecycle: 'open',
          descriptor: { version: 1, body: {} },
        }),
      ),
    appLogReattach: async () => ({ status: 'missing' }),
    appLogCleanup: async () => ({ status: 'cleaned' }),
    networkDump: async (input) => ({
      source: 'app-log',
      backend: 'android',
      dump: {
        path: '/tmp/app.log',
        exists: false,
        scannedLines: 0,
        matchedLines: 0,
        entries: [],
        include: input.include,
        limits: {
          maxEntries: input.maxEntries,
          maxPayloadChars: input.maxPayloadChars,
          maxScanLines: input.maxScanLines,
        },
      },
      notes: [],
    }),
  };
  const bindingDispose = vi.fn(async () => {
    if (disposeError) throw disposeError;
  });
  const bind = vi.fn(async ({ device }) => ({
    device,
    owner,
    facts: {
      device: { family: 'android' as const, kind: device.kind, providerMode: 'local' as const },
      operations: {
        appLogInspect: { available: true as const },
        appLogDoctor: { available: true as const },
        appLogStart: { available: true as const },
        appLogReattach: { available: true as const },
        appLogCleanup: { available: true as const },
        networkDump: { available: true as const },
      },
    },
    operations,
    [Symbol.asyncDispose]: bindingDispose,
  }));
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    bind,
    shutdown: async () => {},
  };
  return { gateway, bind, bindingDispose, forceCleanup, handle };
}
