import type { DeviceInfo } from '@agent-device/kernel/device';
import { type ExecBackgroundResult, type ExecResult } from '@agent-device/host-kit/command';
import { createScopedProvider } from '@agent-device/kernel/scoped-provider';

export type AppleSimulatorScreenRecordingProcess = Readonly<{
  child: Pick<ExecBackgroundResult['child'], 'kill' | 'pid'>;
  wait: Promise<ExecResult>;
}>;

export type AppleSimulatorScreenRecordingRequest = Readonly<{
  device: DeviceInfo;
  outputPath: string;
  signal?: AbortSignal;
}>;

export type AppleSimulatorScreenRecordingTransport = Readonly<{
  available: boolean;
  mode: 'local' | 'transport-composed';
  start(
    request: AppleSimulatorScreenRecordingRequest,
  ): AppleSimulatorScreenRecordingProcess | Promise<AppleSimulatorScreenRecordingProcess>;
}>;

const localTransport: AppleSimulatorScreenRecordingTransport = Object.freeze({
  available: true,
  mode: 'local',
  async start({ device, outputPath, signal }) {
    const [{ buildSimctlArgsForDevice }, { runCmdBackground }] = await Promise.all([
      import('./platforms/apple/core/simctl.ts'),
      import('@agent-device/host-kit/command'),
    ]);
    signal?.throwIfAborted();
    return runCmdBackground(
      'xcrun',
      buildSimctlArgsForDevice(device, ['io', device.id, 'recordVideo', outputPath]),
      { allowFailure: true },
    );
  },
});

const unavailableScopedTransport: AppleSimulatorScreenRecordingTransport = Object.freeze({
  available: false,
  mode: 'transport-composed',
  start: async () => {
    throw new Error(
      'Scoped Apple provider does not expose an Apple simulator screen-recording transport',
    );
  },
});

const transportScope = createScopedProvider(localTransport);

export function resolveAppleSimulatorScreenRecordingTransport(): AppleSimulatorScreenRecordingTransport {
  return transportScope.resolve();
}

export async function withAppleSimulatorScreenRecordingTransport<T>(
  transport: AppleSimulatorScreenRecordingTransport | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return await transportScope.run(transport ?? unavailableScopedTransport, task);
}
