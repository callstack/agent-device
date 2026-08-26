import type { AppleScreenRecordingRunnerRequest } from '@agent-device/contracts/screen-recording-runtime-host';
import type { ManagedProcessOwnership } from '@agent-device/contracts/platform-runtime-host';
import type { DeviceInfo } from '@agent-device/kernel/device';

export async function runAppleRecordingRunner(
  device: DeviceInfo,
  request: AppleScreenRecordingRunnerRequest,
  signal?: AbortSignal,
) {
  const { resolveAppleRunnerScreenRecordingTransport } =
    await import('./platform-runtime-screen-recording-apple-runner-transport.ts');
  const transport = resolveAppleRunnerScreenRecordingTransport();
  if (request.kind === 'stop') {
    if (transport.authority !== request.runnerAuthority) {
      throw new Error('Apple runner recording ownership changed before cleanup');
    }
    await transport.stop({
      device,
      runnerSessionId: request.runnerSessionId,
      appBundleId: request.appBundleId,
      signal,
    });
    return {};
  }
  const result = await transport.start({
    device,
    appBundleId: request.appBundleId,
    outputPath: request.outputPath,
    fps: request.fps,
    signal,
  });
  return Object.freeze({
    runnerSessionId: result.runnerSessionId,
    runnerAuthority: transport.authority,
    ...(result.remotePath === undefined ? {} : { remotePath: result.remotePath }),
    ...(typeof result.recorderStartUptimeMs === 'number'
      ? { recorderStartUptimeMs: result.recorderStartUptimeMs }
      : {}),
    ...(typeof result.targetAppReadyUptimeMs === 'number'
      ? { targetAppReadyUptimeMs: result.targetAppReadyUptimeMs }
      : {}),
  });
}

export async function inspectAppleRunnerOwnership(
  device: DeviceInfo,
  runnerSessionId: string,
  runnerAuthority: 'local-lease' | 'scoped-provider',
): Promise<ManagedProcessOwnership> {
  const { resolveAppleRunnerScreenRecordingTransport } =
    await import('./platform-runtime-screen-recording-apple-runner-transport.ts');
  const transport = resolveAppleRunnerScreenRecordingTransport();
  return transport.authority === runnerAuthority
    ? await transport.inspect(device, runnerSessionId)
    : 'ownership-lost';
}

export async function retrieveAppleRunnerRecording(
  device: DeviceInfo,
  remotePath: string,
  outputPath: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const { resolveIosPhysicalDeviceControl } =
    await import('./platforms/apple/core/physical-device-control.ts');
  await resolveIosPhysicalDeviceControl(device).copyRunnerFile(device, remotePath, outputPath);
  signal?.throwIfAborted();
}

export async function captureAppleClockAnchor(
  device: DeviceInfo,
  appBundleId: string,
  signal?: AbortSignal,
) {
  try {
    const [simulatorTransport, runnerTransport] = await Promise.all([
      import('./platform-runtime-screen-recording-apple-transport.ts').then((module) =>
        module.resolveAppleSimulatorScreenRecordingTransport(),
      ),
      import('./platform-runtime-screen-recording-apple-runner-transport.ts').then((module) =>
        module.resolveAppleRunnerScreenRecordingTransport(),
      ),
    ]);
    if (
      simulatorTransport.mode === 'transport-composed' &&
      runnerTransport.authority !== 'scoped-provider'
    ) {
      return undefined;
    }
    const { runAppleRunnerCommand } =
      await import('./platforms/apple/core/runner/runner-client.ts');
    const result = await runAppleRunnerCommand(
      device,
      { command: 'snapshot', appBundleId, interactiveOnly: true, depth: 1 },
      { signal },
    );
    const wallClockAtMs = Date.now();
    return typeof result.currentUptimeMs === 'number' &&
      Number.isFinite(result.currentUptimeMs) &&
      result.currentUptimeMs > 0
      ? { wallClockAtMs, uptimeMs: result.currentUptimeMs }
      : undefined;
  } catch (_error) {
    signal?.throwIfAborted();
    return undefined;
  }
}

export async function isAppleRunnerBundleId(bundleId: string): Promise<boolean> {
  const { IOS_RUNNER_CONTAINER_BUNDLE_IDS } =
    await import('./platforms/apple/core/runner/runner-client.ts');
  return IOS_RUNNER_CONTAINER_BUNDLE_IDS.includes(bundleId);
}
