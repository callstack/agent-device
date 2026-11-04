import fs from 'node:fs';
import path from 'node:path';
import {
  IOS_SIMULATOR,
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
} from '@agent-device/test-kit';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { deviceIdentity } from '@agent-device/kernel/device';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import type { DaemonPlatformServices } from '../../../core/platform-services.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { createRequestExecutionScope } from '../../../server/request-execution-scope.ts';
import { handleRecordCommand } from '../../../sessions/handlers/record-runtime.ts';
import { platformRequestScopeFixture } from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';

export function cleanupCrashFixture(
  stateDir: string,
  claimsDir: string,
  publish = true,
  failDisposal = false,
  retainSession = false,
  recordOnlySession = false,
  pendingNative = false,
  requestSignal?: AbortSignal,
  hangReattach?: () => void,
) {
  const host = createTestHostEnvironment({
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
  });
  const store = new SessionStore(path.join(stateDir, 'sessions'), host);
  const device = IOS_SIMULATOR;
  const owner = localRuntimeOwner('apple');
  const output = path.join(stateDir, 'export.mp4');
  const events = path.join(stateDir, 'effects');
  const snapshot = {
    backend: 'fixture',
    outPath: output,
    startedAt: 1,
    scope: 'device' as const,
    showTouches: false,
    recordOnlySession: false,
    gestureEvents: [],
  };
  const handle = createScreenRecordingLiveHandle(snapshot, {
    finish: async () => {
      fs.appendFileSync(events, 'finish\n');
      fs.writeFileSync(output, 'preserved export');
      return {
        status: 'completed' as const,
        result: {
          backend: 'fixture',
          outPath: output,
          startedAt: 1,
          completedAt: 2,
          scope: 'device' as const,
          showTouches: false,
          recordOnlySession: false,
        },
        ...(pendingNative
          ? {
              cleanupPending: {
                status: 'cleanup-pending' as const,
                reason: 'cleanup-unconfirmed' as const,
              },
            }
          : {}),
      };
    },
    forceCleanup: async () =>
      pendingNative
        ? ({ status: 'cleanup-pending', reason: 'cleanup-unconfirmed' } as const)
        : ({ status: 'cleaned' } as const),
  });
  const base = createUnavailableRuntimeFactsForTest(device, owner);
  const facts = {
    ...base,
    operations: {
      ...base.operations,
      screenRecordingStart: { available: true as const },
      screenRecordingReattach: { available: true as const },
      screenRecordingCleanup: { available: true as const },
    },
  };
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async () => facts,
    bind: async ({ scope }) => ({
      device,
      owner,
      facts,
      operations: {
        screenRecordingStart: async (input) => {
          fs.appendFileSync(events, 'start\n');
          return {
            pendingHandle: new PendingTransferGuard(handle),
            envelope: createDurableResourceEnvelope({
              resourceKind: 'screen-recording',
              sessionId: input.sessionId,
              device: deviceIdentity(device),
              owner,
              fence: input.fence,
              lifecycle: 'open',
              descriptor: { version: 1, body: { outputPath: output } },
            }),
          };
        },
        screenRecordingReattach: async () => {
          fs.appendFileSync(events, 'reattach\n');
          if (hangReattach) {
            hangReattach();
            await new Promise<never>((_resolve, reject) => {
              if (scope.signal.aborted) reject(scope.signal.reason);
              else
                scope.signal.addEventListener('abort', () => reject(scope.signal.reason), {
                  once: true,
                });
            });
          }
          return { status: 'export' as const, handle };
        },
        screenRecordingCleanup: async () => ({ status: 'cleaned' as const }),
      },
      [Symbol.asyncDispose]: async () => {
        fs.appendFileSync(events, 'dispose\n');
        if (failDisposal) throw new Error('in-process binding disposal failed');
      },
    }),
    shutdown: async () => {},
  };
  const services: DaemonPlatformServices = {
    appleSessionObservation: {
      observeRunnerSession: async () => undefined,
      resolveSoleForegroundApp: async () => undefined,
    },
    deviceBootObservation: {
      observeBootTimeMs: async () => ({ observed: false, reason: 'unobserved' }),
    },
    ensureLocalDeviceReady: async () => true,
    resolveRequestedOpenSurface: ({ existingSurface }) => existingSurface ?? 'app',
    validateOpenRelaunchTarget: async () => undefined,
    resolveSessionAppBundleIdForTarget: async (_device, _target, current) => current,
  };
  const platformScope = {
    ...platformRequestScopeFixture(),
    ...(requestSignal ? { signal: requestSignal } : {}),
  };
  if (publish)
    store.publish('recording', {
      name: 'recording',
      device,
      createdAt: 1,
      actions: [],
      recordOnlySession,
      ...(retainSession ? { appBundleId: 'com.example.app' } : {}),
    });
  async function record(action: 'start' | 'stop') {
    const scope = await createRequestExecutionScope({
      host,
      req: {
        token: 't',
        session: 'recording',
        command: 'record',
        positionals: [action],
        flags: { recordingScope: 'device' },
        meta: { sessionExplicit: true },
      },
      sessionStore: store,
      leaseRegistry: new LeaseRegistry(),
      deviceRuntimeGateway: gateway,
      claimRecoveryGateway: () => gateway,
      platformServices: services,
      platformRequestScope: platformScope,
    });
    const response = await scope.runLocked(
      async () =>
        await handleRecordCommand({
          req: scope.req,
          sessionName: scope.sessionName,
          sessionStore: store,
          bindDevice: scope.bindDevice,
          bindExactDevice: scope.bindExactDevice,
          admissionLedger: createScreenRecordingAdmissionLedger(),
          requestScope: platformScope,
          platformServices: scope.platformServices,
          retainDeviceExecutionLock: scope.retainDeviceExecutionLock,
          throwIfCanceled: scope.throwIfCanceled,
        }),
    );
    await scope[Symbol.asyncDispose]();
    return response;
  }
  return {
    output,
    events,
    host,
    gateway,
    platformScope,
    stop: async () => await record('stop'),
    start: async () => await record('start'),
  };
}
