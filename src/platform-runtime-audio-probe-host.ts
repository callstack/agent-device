import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type {
  AudioProbeRuntimeHost,
  HostAudioCaptureProcess,
  WebAudioProbeTransport,
} from '@agent-device/contracts/audio-probe-runtime-host';
import type {
  ManagedProcessIdentity,
  OwnedProcessRecordWriter,
} from '@agent-device/contracts/platform-runtime-host';
import {
  inspectManagedProcess,
  resolveManagedProcessIdentity,
  terminateManagedProcessSet,
} from './platform-runtime-screen-recording-process-host.ts';

/**
 * One host capture backend serves every darwin-hosted family: the macOS helper's
 * ScreenCaptureKit sampler taps host system audio whether the session is a macOS app, an iOS
 * simulator, or an Android emulator. The owner packages state which of their cells reach it.
 */
export function createAudioProbeRuntimeHost(options: {
  ownedProcesses?: OwnedProcessRecordWriter;
  host: HostEnvironment;
}): AudioProbeRuntimeHost {
  const host = options.host;
  const ownedProcesses: OwnedProcessRecordWriter =
    options.ownedProcesses ??
    Object.freeze({
      replace: () => {},
      clear: () => {},
    });
  return Object.freeze({
    hostCapture: Object.freeze({
      info: Object.freeze({
        source: 'system-audio' as const,
        backend: 'macos-screencapturekit',
        sourceCount: 1,
        notes: hostSystemAudioProbeNotes,
      }),
      start: async (input: {
        durationMs: number;
        bucketMs: number;
        statusPath: string;
      }): Promise<HostAudioCaptureProcess> => {
        const { startMacOsAudioProbeProcess } = await import('@agent-device/platform-apple/macos');
        const probe = await startMacOsAudioProbeProcess({ ...input, env: host.env });
        const marker = await resolveManagedProcessIdentity(probe.child.pid ?? undefined);
        return Object.freeze({
          ...(marker === undefined ? {} : { marker }),
          wait: probe.wait,
          terminate: async () => {
            probe.child.kill('SIGTERM');
            await probe.wait.catch(() => {});
          },
        });
      },
      inspectProcess: async (marker: ManagedProcessIdentity) => inspectManagedProcess(marker),
      terminateProcess: async (marker: ManagedProcessIdentity) =>
        await terminateManagedProcessSet([marker]),
    }),
    web: Object.freeze({
      resolve: async (device: DeviceInfo): Promise<WebAudioProbeTransport | undefined> => {
        if (device.platform !== 'web') return undefined;
        const { resolveWebProviderForHost } = await import('@agent-device/platform-web');
        // Every reader of one web request resolves the same provider through the one policy
        // (#3794).
        const provider = await resolveWebProviderForHost(host);
        const probeAudio = provider.probeAudio?.bind(provider);
        if (!probeAudio) return undefined;
        return Object.freeze({
          probe: async (input) =>
            await probeAudio({
              action: input.action,
              durationMs: input.durationMs,
              bucketMs: input.bucketMs,
            }),
        });
      },
    }),
    ownedProcesses,
  });
}

function hostSystemAudioProbeNotes(device: DeviceInfo): string[] {
  const target = isIosFamily(device)
    ? 'iOS simulator'
    : device.platform === 'android'
      ? 'Android emulator'
      : 'macOS session';
  return [
    `Audio probe samples host system audio through ScreenCaptureKit for this ${target}; it is not app-instrumented audio.`,
    'Screen Recording permission is required for host system audio capture.',
    'Other audible host apps can contribute to the measured buckets.',
  ];
}
