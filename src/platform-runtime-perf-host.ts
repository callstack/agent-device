import type { PerfRuntimeHost } from '@agent-device/contracts/perf-runtime-host';
import type { PerfProfileHandoff } from '@agent-device/contracts/perf-runtime';
import { AppError } from '@agent-device/kernel/errors';
import type { AndroidNativePerfSession } from '@agent-device/platform-android/mechanics';
import {
  cleanupAndroidPerfCaptureDescriptor,
  cleanupApplePerfCaptureDescriptor,
  inspectAndroidPerfCaptureDescriptor,
  inspectApplePerfCaptureDescriptor,
  startAndroidPerfCapture,
  startApplePerfCapture,
} from './platform-runtime-perf-capture-host.ts';
import { loadAndroidMechanics } from './platform-runtime-android-mechanics.ts';

const loadAndroidPerf = loadAndroidMechanics;
const loadAndroidFramePerf = loadAndroidMechanics;
const loadAndroidNativePerf = loadAndroidMechanics;
const loadApplePerf = async () => await import('@agent-device/platform-apple/perf');
const loadApplePerfMechanics = async () => await import('@agent-device/platform-apple/perf');
const loadAppleXctrace = async () => await import('@agent-device/platform-apple/perf');
const loadHarmonyPerf = async () => await import('@agent-device/platform-harmonyos');

/** Lazy host-only mechanics. Platform packages own facts, policy, and operation construction. */
export function createPerfRuntimeHost(): PerfRuntimeHost {
  const apple: PerfRuntimeHost['apple'] = Object.freeze({
    sampleFrames: async (device, appId) =>
      await (await loadApplePerf()).sampleAppleFramePerf(device, appId),
    frameSampling: async (device) =>
      (await loadApplePerfMechanics()).buildAppleFrameSamplingMetadata(device),
    sampleMemory: async (device, appId) =>
      await (await loadApplePerf()).sampleAppleMemoryPerf(device, appId),
    memorySampling: async (device) =>
      (await loadApplePerfMechanics()).buildAppleMemorySamplingMetadata(device),
    memorySnapshotSupport: async (device) =>
      (await loadApplePerfMechanics()).buildAppleMemorySnapshotSupport(device),
    captureMemorySnapshot: async (device, appId, outputPath) =>
      await (await loadApplePerf()).captureAppleMemorySnapshot(device, appId, outputPath),
    start: async (device, owner, input) => await startApplePerfCapture(device, owner, input),
    reattach: async (_device, { envelope }) => await inspectApplePerfCaptureDescriptor(envelope),
    cleanup: async (_device, { envelope }) => await cleanupApplePerfCaptureDescriptor(envelope),
    writeProfileReport: async (input) =>
      await (
        await loadAppleXctrace()
      ).writeAppleXctracePerfReport({
        tracePath: input.tracePath,
        outPath: input.outPath,
        template: input.template,
        appBundleId: input.appId,
      }),
  });
  const android: PerfRuntimeHost['android'] = Object.freeze({
    sampleFrames: async (device, appId) =>
      await (await loadAndroidFramePerf()).sampleAndroidFramePerf(device, appId),
    sampleMemory: async (device, appId) =>
      await (await loadAndroidPerf()).sampleAndroidMemoryPerf(device, appId),
    captureMemorySnapshot: async (device, appId, outputPath) =>
      await (await loadAndroidPerf()).captureAndroidHeapSnapshot(device, appId, outputPath),
    start: async (device, owner, input) => await startAndroidPerfCapture(device, owner, input),
    reattach: async (_device, { envelope }) => await inspectAndroidPerfCaptureDescriptor(envelope),
    cleanup: async (device, { envelope }) =>
      await cleanupAndroidPerfCaptureDescriptor(device, envelope),
    writeProfileReport: async (device, input) =>
      await (
        await loadAndroidNativePerf()
      ).writeAndroidSimpleperfReport(
        device,
        readStoppedAndroidProfile(input.profile, input.tracePath),
        input.outPath,
      ),
  });
  const harmony: PerfRuntimeHost['harmony'] = Object.freeze({
    sampleMemory: async (device, appId) =>
      await (await loadHarmonyPerf()).sampleHarmonyMemoryPerf(device, appId),
  });
  return Object.freeze({ apple, android, harmony });
}

// Durable data is untrusted at this boundary; keep every required discriminator explicit.
// fallow-ignore-next-line complexity
function readStoppedAndroidProfile(
  profile: PerfProfileHandoff | undefined,
  tracePath: string,
): AndroidNativePerfSession {
  if (
    profile?.kind !== 'simpleperf' ||
    profile.type !== 'cpu-profile' ||
    profile.mode !== 'cpu-profile'
  ) {
    throw new AppError('INVALID_ARGS', 'Stopped Simpleperf profile metadata is malformed.');
  }
  return {
    type: 'cpu-profile',
    kind: 'simpleperf',
    packageName: profile.packageName,
    appPid: profile.appPid,
    profilerPid: profile.profilerPid,
    remotePath: profile.remotePath,
    outPath: tracePath,
    startedAt: profile.startedAt ? Date.parse(profile.startedAt) : Date.now(),
    state: 'stopped',
    ...(profile.stoppedAt ? { stoppedAt: Date.parse(profile.stoppedAt) } : {}),
    ...(profile.sizeBytes === undefined ? {} : { sizeBytes: profile.sizeBytes }),
  };
}
