import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { NativeManifest } from './manifest.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

/** Publish evidence atomically, so a reader never observes a half-written marker. */
export async function persistNativeManifest(
  transport: Transport,
  manifestPath: string,
  evidence: NativeManifest,
  signal?: AbortSignal,
): Promise<void> {
  await transport.writeManifest({ manifestPath, contents: JSON.stringify(evidence) }, signal);
}

export async function removeNativeManifest(
  transport: Transport,
  manifestPath: string,
): Promise<void> {
  if (!(await transport.removeManifest(manifestPath))) {
    throw new Error(`failed to remove Android recording manifest: ${manifestPath}`);
  }
}
