import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type {
  CleanupOutcome,
  RuntimeOwnerRef,
  ScreenRecordingRuntimeHost,
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/platform';
import {
  PendingTransferGuard,
  SCREEN_RECORDING_RESOURCE_KIND,
} from '@agent-device/contracts/platform';
import {
  assertScreenRecordingOptionsSupported,
  createScreenRecordingCompletion,
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
  encodeDurableDescriptor,
} from '@agent-device/capture-kit';

type WebScreenRecordingOperationHost = Readonly<{
  screenRecording: Pick<ScreenRecordingRuntimeHost, 'web' | 'finalize' | 'outputs'>;
}>;

const descriptorCodec = Object.freeze({
  resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
  version: 1,
  encode: (descriptor: WebRecordingDescriptor) => ({ ...descriptor }),
  decode: (body: Record<string, unknown>) =>
    body.backend === 'agent-browser' && typeof body.outputPath === 'string'
      ? ({
          status: 'decoded',
          descriptor: Object.freeze({ backend: 'agent-browser', outputPath: body.outputPath }),
        } as const)
      : ({ status: 'invalid', message: 'Invalid web screen-recording descriptor' } as const),
});

type WebRecordingDescriptor = Readonly<{ backend: 'agent-browser'; outputPath: string }>;

export async function bindWebScreenRecordingRuntime(params: {
  host: WebScreenRecordingOperationHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  signal: AbortSignal;
}): Promise<{
  available: boolean;
  operations: Partial<ScreenRecordingRuntimeOperations>;
}> {
  const { host, device, owner, signal } = params;
  const transport = await host.screenRecording.web.resolve(device);
  if (!transport) return { available: false, operations: {} };
  return {
    available: true,
    operations: {
      screenRecordingStart: async (input) =>
        await startWebRecording({ host, transport, device, owner, input, signal }),
      screenRecordingReattach: async () => ({
        status: 'unreattachable',
        reason: 'transport-not-reattachable',
        message: 'Web recordings cannot be reattached after daemon restart.',
      }),
      screenRecordingCleanup: async () => pendingWebCleanup(),
    },
  };
}

async function startWebRecording(params: {
  host: WebScreenRecordingOperationHost;
  transport: NonNullable<Awaited<ReturnType<ScreenRecordingRuntimeHost['web']['resolve']>>>;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
}) {
  const { host, transport, device, owner, input, signal } = params;
  if (input.recordOnlySession) {
    throw new AppError(
      'INVALID_ARGS',
      'record on web requires an active browser session; run open <url> --platform web first',
    );
  }
  if (!input.outputPath.toLowerCase().endsWith('.webm')) {
    throw new AppError(
      'INVALID_ARGS',
      'web recordings require a .webm output path; agent-browser records WebM directly',
    );
  }
  assertScreenRecordingOptionsSupported(
    input,
    { scopes: ['app'], fps: false, exportQuality: false, hideTouches: false },
    (unsupported) =>
      `web recordings do not support ${unsupported.join(', ')}; agent-browser records WebM directly`,
  );
  signal.throwIfAborted();
  await host.screenRecording.outputs.prepare(input.outputPath);
  let acquired = false;
  try {
    await transport.start(input.outputPath, signal);
    acquired = true;
    signal.throwIfAborted();
  } catch (error) {
    if (acquired) await transport.stop().catch(() => {});
    signal.throwIfAborted();
    throw error;
  }
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    await transport.stop();
    stopped = true;
  };
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'agent-browser',
      outPath: input.outputPath,
      ...(input.clientOutputPath === undefined ? {} : { clientOutPath: input.clientOutputPath }),
      startedAt: Date.now(),
      scope: input.scope,
      showTouches: false,
      recordOnlySession: input.recordOnlySession,
      ...(input.activeSessionApp === undefined ? {} : { activeSessionApp: input.activeSessionApp }),
      gestureEvents: [],
    },
    {
      finish: async (snapshot) => {
        await stop();
        const finalization = await host.screenRecording.finalize.complete({
          outputPath: snapshot.outPath,
          showTouches: false,
          gestureEvents: snapshot.gestureEvents,
          targetLabel: 'web recording',
        });
        return createScreenRecordingCompletion(snapshot, finalization, false);
      },
      forceCleanup: async () => {
        try {
          await stop();
          return { status: 'cleaned' } as const;
        } catch (error) {
          return {
            status: 'cleanup-pending',
            reason: 'transport-failed',
            message: error instanceof Error ? error.message : 'Web recording cleanup failed',
          } as const;
        }
      },
    },
  );
  return Object.freeze({
    pendingHandle: new PendingTransferGuard(handle),
    envelope: createDurableResourceEnvelope({
      resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
      sessionId: input.sessionId,
      device: deviceIdentity(device),
      owner,
      fence: input.fence,
      lifecycle: 'open',
      descriptor: encodeDurableDescriptor(descriptorCodec, {
        backend: 'agent-browser',
        outputPath: input.outputPath,
      }),
    }),
  });
}

function pendingWebCleanup(): CleanupOutcome {
  return {
    status: 'cleanup-pending',
    reason: 'manual-recovery-required',
    message: 'Web recordings cannot be cleaned after daemon restart.',
  };
}
