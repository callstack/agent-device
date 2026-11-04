import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';
import {
  ANDROID_EMULATOR,
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
} from '@agent-device/test-kit';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { deviceIdentity } from '@agent-device/kernel/device';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { createRequestExecutionScope } from '../../../server/request-execution-scope.ts';
import { handleRecordCommand } from '../../../sessions/handlers/record-runtime.ts';
import type { IsolatedDeviceClaimStore } from '../../../__tests__/support/device-claim-store.ts';
import { platformRequestScopeFixture } from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';

export function fixture(setup: () => IsolatedDeviceClaimStore) {
  const { root, stateDir, claimsDir } = setup();
  const workspace = path.join(root, 'worktree');
  const subdir = path.join(workspace, 'nested');
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  fs.mkdirSync(foreign, { recursive: true });
  const host = createTestHostEnvironment({
    cwd: workspace,
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
  });
  const store = new SessionStore(path.join(stateDir, 'sessions'), host);
  const registry = new LeaseRegistry();
  const scope = platformRequestScopeFixture();
  const device = ANDROID_EMULATOR;
  const owner = localRuntimeOwner('android');
  const output = path.join(stateDir, 'output.mp4');
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'fixture',
      outPath: output,
      startedAt: 1,
      scope: 'device',
      showTouches: false,
      recordOnlySession: true,
      gestureEvents: [],
    },
    {
      finish: async () => {
        fs.writeFileSync(output, 'video');
        return {
          status: 'completed' as const,
          result: {
            backend: 'fixture',
            outPath: output,
            startedAt: 1,
            completedAt: 2,
            scope: 'device' as const,
            showTouches: false,
            recordOnlySession: true,
          },
        };
      },
      forceCleanup: async () => ({ status: 'cleaned' as const }),
    },
  );
  const start = vi.fn(
    async (input: Parameters<PlatformRuntimeOperations['screenRecordingStart']>[0]) => ({
      pendingHandle: new PendingTransferGuard(handle),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: input.sessionId,
        device: deviceIdentity(device),
        owner,
        fence: input.fence,
        lifecycle: 'open',
        descriptor: { version: 1, body: {} },
      }),
    }),
  );
  const reattach = vi.fn(async () => ({ status: 'missing' as const }));
  let startRecovery: 'confirmed-no-effect' | 'retained' = 'retained';
  const recoverIncompleteRecordingStart = vi.fn(async () => startRecovery);
  const closeApplication = vi.fn(async () => {});
  const finalizeApplicationClose = vi.fn(async () => ({}));
  let disposeBinding: () => Promise<void> = async () => {};
  let retryBinding: (() => Promise<void>) | undefined;
  const factsBase = createUnavailableRuntimeFactsForTest(device, owner);
  const facts = {
    ...factsBase,
    operations: {
      ...factsBase.operations,
      screenRecordingStart: { available: true as const },
      screenRecordingReattach: { available: true as const },
      screenRecordingCleanup: { available: true as const },
      closeApplication: { available: true as const },
      finalizeApplicationClose: { available: true as const },
    },
  };
  let gateway = {
    inspectFacts: async () => facts,
    bind: async () => {
      const dispose = disposeBinding;
      const retry = retryBinding;
      disposeBinding = async () => {};
      retryBinding = undefined;
      return {
        device,
        owner,
        facts,
        recoverIncompleteRecordingStart,
        operations: {
          screenRecordingStart: start,
          screenRecordingReattach: reattach,
          screenRecordingCleanup: async () => ({ status: 'cleaned' as const }),
          closeApplication,
          finalizeApplicationClose,
        },
        ...(retry ? { retryDisposal: retry } : {}),
        [Symbol.asyncDispose]: async () => await dispose(),
      };
    },
    shutdown: async () => {},
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  async function scopeFor(
    command: string,
    action: string | undefined,
    cwd: string | undefined,
    state = store,
    requestRegistry = registry,
  ) {
    return await createRequestExecutionScope({
      host,
      req: {
        token: 't',
        session: 'recording',
        command,
        positionals: action ? [action] : [],
        flags: { recordingScope: 'device' },
        ...(cwd ? { meta: { cwd } } : {}),
      },
      sessionStore: state,
      leaseRegistry: requestRegistry,
      deviceRuntimeGateway: gateway,
      claimRecoveryGateway: () => gateway,
      platformServices: daemonPlatformServicesFixture(),
      platformRequestScope: scope,
    });
  }
  async function record(
    action: 'start' | 'stop',
    cwd: string | undefined,
    state = store,
    requestRegistry = registry,
    cancelAdoption = false,
  ) {
    const request = await scopeFor('record', action, cwd, state, requestRegistry);
    const response = await request.runLocked(
      async () =>
        await handleRecordCommand({
          req: request.req,
          sessionName: request.sessionName,
          sessionStore: state,
          bindDevice: request.bindDevice,
          bindExactDevice: request.bindExactDevice,
          admissionLedger: createScreenRecordingAdmissionLedger(),
          requestScope: scope,
          platformServices: request.platformServices,
          retainDeviceExecutionLock: request.retainDeviceExecutionLock,
          throwIfCanceled: cancelAdoption
            ? () => {
                throw new Error('adoption canceled');
              }
            : request.throwIfCanceled,
        }),
    );
    await request[Symbol.asyncDispose]();
    return response;
  }
  function publish(recordOnlySession: boolean) {
    return store.publish('recording', {
      name: 'recording',
      device,
      createdAt: 1,
      actions: [],
      recordOnlySession,
    });
  }
  const manifestPath = screenRecordingDurableResource.store.resolvePath(
    store.resolveSessionDir('recording'),
  );
  return {
    root,
    stateDir,
    claimsDir,
    workspace,
    subdir,
    foreign,
    host,
    store,
    registry,
    scopeFor,
    record,
    publish,
    manifestPath,
    start,
    reattach,
    device,
    gateway,
    scope,
    recoverIncompleteRecordingStart,
    closeApplication,
    setBindingDisposal: (dispose: () => Promise<void>) => {
      disposeBinding = dispose;
    },
    setBindingRetry: (retry: () => Promise<void>) => {
      retryBinding = retry;
    },
    setGateway: (value: DeviceRuntimeGateway<PlatformRuntimeOperations>) => {
      gateway = value;
    },
    setStartRecovery: (value: 'confirmed-no-effect' | 'retained') => {
      startRecovery = value;
    },
  };
}
