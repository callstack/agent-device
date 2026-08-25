import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AudioProbeQueryInput } from './audio-probe-runtime.ts';
import type { AudioProbeResult, AudioProbeSource } from './audio-probe-result.ts';
import type {
  HostCommandResult,
  ManagedProcessIdentity,
  ManagedProcessOwnership,
  OwnedProcessRecordWriter,
} from './platform-runtime-host.ts';

/** A long-lived native host audio sampler. It deliberately carries no request scope. */
export type HostAudioCaptureProcess = Readonly<{
  marker?: ManagedProcessIdentity;
  wait: Promise<HostCommandResult>;
  terminate(): Promise<void>;
}>;

/** Static identity of the one host capture backend serving darwin-hosted families. */
export type HostAudioCaptureBackendInfo = Readonly<{
  source: AudioProbeSource;
  backend: string;
  sourceCount: number;
  notes(device: DeviceInfo): readonly string[];
}>;

export type HostSystemAudioCaptureHost = Readonly<{
  info: HostAudioCaptureBackendInfo;
  start(
    input: Readonly<{ durationMs: number; bucketMs: number; statusPath: string }>,
  ): Promise<HostAudioCaptureProcess>;
  /** Exact-identity liveness for cleanup-only recovery of an orphaned sampler. */
  inspectProcess(marker: ManagedProcessIdentity): Promise<ManagedProcessOwnership>;
  terminateProcess(
    marker: ManagedProcessIdentity,
  ): Promise<'terminated' | 'already-missing' | 'ownership-lost'>;
}>;

export type WebAudioProbeTransport = Readonly<{
  probe(input: AudioProbeQueryInput): Promise<AudioProbeResult>;
}>;

export type WebAudioProbeHost = Readonly<{
  resolve(device: DeviceInfo): Promise<WebAudioProbeTransport | undefined>;
}>;

/** Focused host authorities consumed only by package-owned audio-probe mechanics. */
export type AudioProbeRuntimeHost = Readonly<{
  hostCapture: HostSystemAudioCaptureHost;
  web: WebAudioProbeHost;
  ownedProcesses: OwnedProcessRecordWriter;
}>;
