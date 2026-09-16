import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { ScreenRecordingRuntimeHost } from '@agent-device/contracts/screen-recording-runtime-host';
import type {
  ScreenRecordingRuntimeOperations,
  ScreenRecordingStartInput,
} from '@agent-device/contracts/screen-recording-runtime';
import {
  startTransportScreenRecording,
  transportRecordingCleanupPending,
  transportRecordingUnreattachable,
} from '@agent-device/capture-kit/screen-recording-transport';

type WebScreenRecordingOperationHost = Readonly<{
  screenRecording: Pick<ScreenRecordingRuntimeHost, 'web' | 'finalize' | 'outputs'>;
}>;

const WEB_RECORDING_BACKEND = 'agent-browser';

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
      screenRecordingStart: async (input) => {
        assertWebRecordingInput(input);
        // The browser writes the WebM at the output path itself, so there is nothing to collect.
        return await startTransportScreenRecording({
          host,
          device,
          owner,
          input,
          signal,
          transport: {
            backend: WEB_RECORDING_BACKEND,
            targetLabel: 'web recording',
            start: async (startSignal) => await transport.start(input.outputPath, startSignal),
            stop: async () => await transport.stop(),
          },
          support: { scopes: ['app'], fps: false, exportQuality: false, hideTouches: false },
          unsupported: (unsupported) =>
            `web recordings do not support ${unsupported.join(', ')}; agent-browser records WebM directly`,
        });
      },
      screenRecordingReattach: async () =>
        transportRecordingUnreattachable(
          'Web recordings cannot be reattached after daemon restart.',
        ),
      screenRecordingCleanup: async () =>
        transportRecordingCleanupPending('Web recordings cannot be cleaned after daemon restart.'),
    },
  };
}

function assertWebRecordingInput(input: ScreenRecordingStartInput): void {
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
}
