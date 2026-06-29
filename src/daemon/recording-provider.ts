import { buildSimctlArgsForDevice } from '../platforms/ios/simctl.ts';
import type { DeviceInfo } from '../kernel/device.ts';
import { runCmdBackground, type ExecBackgroundResult, type ExecResult } from '../utils/exec.ts';
import { createScopedProvider } from '../utils/scoped-provider.ts';

export type RecordingProcess = {
  child: Pick<ExecBackgroundResult['child'], 'kill' | 'pid'>;
  wait: Promise<ExecResult>;
};

export type IosSimulatorRecordingRequest = {
  device: DeviceInfo;
  outPath: string;
};

export type RecordingProvider = {
  startIosSimulatorRecording(request: IosSimulatorRecordingRequest): RecordingProcess;
};

const localRecordingProvider: RecordingProvider = {
  startIosSimulatorRecording({ device, outPath }) {
    return runCmdBackground(
      'xcrun',
      buildSimctlArgsForDevice(device, ['io', device.id, 'recordVideo', outPath]),
      { allowFailure: true },
    );
  },
};

const recordingProviderScope = createScopedProvider(
  localRecordingProvider,
  createLocalRecordingProvider,
);

export function createLocalRecordingProvider(
  provider: Partial<RecordingProvider> = {},
): RecordingProvider {
  return {
    ...localRecordingProvider,
    ...provider,
  };
}

export function resolveRecordingProvider(provider?: RecordingProvider): RecordingProvider {
  return recordingProviderScope.resolve(provider);
}

export async function withRecordingProvider<T>(
  provider: RecordingProvider | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return await recordingProviderScope.run(provider, fn);
}
