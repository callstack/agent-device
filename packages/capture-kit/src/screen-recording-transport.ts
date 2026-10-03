import { deviceIdentity, type DeviceInfo } from '@agent-device/kernel/device';
import type { CleanupOutcome } from '@agent-device/contracts/durable-resource';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import {
  type ScreenRecordingLiveSnapshot,
  type ScreenRecordingStartInput,
  type ScreenRecordingStartResult,
  SCREEN_RECORDING_RESOURCE_KIND,
} from '@agent-device/contracts/screen-recording-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
} from './durable-resource-envelope.ts';
import { createScreenRecordingCompletion } from './screen-recording-completion.ts';
import { createScreenRecordingLiveHandle } from './screen-recording-live-handle.ts';
import { assertScreenRecordingOptionsSupported } from './screen-recording-options.ts';

/**
 * A recorder that lives behind a provider transport: the daemon never sees a process, only a
 * start call, one stop call, and (when the provider serves the file rather than writing it)
 * a collect step that brings the media to the output path.
 *
 * `stop` runs at most once per recording; its answer is kept for every later `finish`, so a
 * failed `collect` is retried by the next stop without asking the provider to stop again.
 */
export type ScreenRecordingTransport<Collectible = void> = Readonly<{
  /** Names the recorder in snapshots, completions, and the durable descriptor. */
  backend: string;
  /** What the finalizer calls the export in its messages. */
  targetLabel: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<Collectible>;
  /**
   * Brings the finished media to `outputPath`. Omitted when the recorder writes `outputPath`
   * itself. Runs inside `finish`, so it owns its own deadline: nothing can cancel it.
   */
  collect?(collectible: Collectible, outputPath: string): Promise<void>;
}>;

export type ScreenRecordingTransportSupport = Parameters<
  typeof assertScreenRecordingOptionsSupported
>[1];

/** The host slice a transport recording owns: preparing the output and finalizing the export. */
export type ScreenRecordingTransportHost = Readonly<{
  screenRecording: Pick<ScreenRecordingRuntimeHost, 'finalize' | 'outputs'>;
}>;

export type TransportRecordingDescriptor = Readonly<{ backend: string; outputPath: string }>;

export function transportRecordingDescriptorCodec(backend: string) {
  return Object.freeze({
    resourceKind: SCREEN_RECORDING_RESOURCE_KIND,
    version: 1,
    encode: (descriptor: TransportRecordingDescriptor) => ({ ...descriptor }),
    decode: (body: Record<string, unknown>) =>
      body.backend === backend && typeof body.outputPath === 'string'
        ? ({
            status: 'decoded',
            descriptor: Object.freeze({ backend, outputPath: body.outputPath }),
          } as const)
        : ({
            status: 'invalid',
            message: `Invalid ${backend} screen-recording descriptor`,
          } as const),
  });
}

/** A transport recording dies with its daemon; after a restart there is nothing to re-drive. */
export function transportRecordingUnreattachable(message: string) {
  return {
    status: 'unreattachable' as const,
    reason: 'transport-not-reattachable' as const,
    message,
  };
}

export function transportRecordingCleanupPending(message: string): CleanupOutcome {
  return { status: 'cleanup-pending', reason: 'manual-recovery-required', message };
}

/**
 * Starts a transport recording: options are checked before the output is touched, the output
 * is prepared, the recorder started (and stopped again if the request is cancelled mid-start),
 * and the live handle owns the memoized stop, the retriable collect, and the finalizer call.
 */
export async function startTransportScreenRecording<Collectible>(params: {
  host: ScreenRecordingTransportHost;
  device: DeviceInfo;
  owner: RuntimeOwnerRef;
  input: ScreenRecordingStartInput;
  signal: AbortSignal;
  transport: ScreenRecordingTransport<Collectible>;
  support: ScreenRecordingTransportSupport;
  unsupported(options: readonly string[]): string;
}): Promise<ScreenRecordingStartResult> {
  const { host, device, owner, input, signal, transport } = params;
  assertScreenRecordingOptionsSupported(input, params.support, params.unsupported);
  signal.throwIfAborted();
  await host.screenRecording.outputs.prepare(input.outputPath);
  const stopOnce = memoizeStop(transport);
  let acquired = false;
  try {
    await transport.start(signal);
    acquired = true;
    signal.throwIfAborted();
  } catch (error) {
    if (acquired) await stopOnce().catch(() => {});
    signal.throwIfAborted();
    throw error;
  }
  const handle = createScreenRecordingLiveHandle(
    transportRecordingSnapshot(transport.backend, input),
    {
      finish: async (current) => {
        const collectible = await stopOnce();
        if (transport.collect) {
          await transport.collect(collectible, current.outPath);
        }
        const finalization = await host.screenRecording.finalize.complete({
          outputPath: current.outPath,
          showTouches: false,
          gestureEvents: current.gestureEvents,
          ...(current.exportQuality === undefined ? {} : { exportQuality: current.exportQuality }),
          targetLabel: transport.targetLabel,
        });
        return createScreenRecordingCompletion(current, finalization, {
          // The provider acknowledged the stop and nothing else writes the export.
          stopObservation: { recorder: 'confirmed' },
          showTouches: false,
        });
      },
      forceCleanup: async () => {
        try {
          await stopOnce();
          return { status: 'cleaned' } as const;
        } catch (error) {
          return {
            status: 'cleanup-pending',
            reason: 'transport-failed',
            message:
              error instanceof Error
                ? error.message
                : `${transport.backend} recording cleanup failed`,
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
      descriptor: encodeDurableDescriptor(transportRecordingDescriptorCodec(transport.backend), {
        backend: transport.backend,
        outputPath: input.outputPath,
      }),
    }),
  });
}

/** One remote stop per recording: a stop that succeeded is never repeated, a failed one may retry. */
function memoizeStop<Collectible>(transport: ScreenRecordingTransport<Collectible>) {
  let stopped: Promise<Collectible> | undefined;
  return () =>
    (stopped ??= transport.stop().catch((error: unknown) => {
      stopped = undefined;
      throw error;
    }));
}

function transportRecordingSnapshot(
  backend: string,
  input: ScreenRecordingStartInput,
): ScreenRecordingLiveSnapshot {
  return Object.freeze({
    backend,
    outPath: input.outputPath,
    ...(input.clientOutputPath === undefined ? {} : { clientOutPath: input.clientOutputPath }),
    startedAt: Date.now(),
    scope: input.scope,
    showTouches: false,
    recordOnlySession: input.recordOnlySession,
    ...(input.activeSessionApp === undefined ? {} : { activeSessionApp: input.activeSessionApp }),
    ...(input.exportQuality === undefined ? {} : { exportQuality: input.exportQuality }),
    gestureEvents: [],
  });
}
