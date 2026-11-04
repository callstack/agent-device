import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { decodeNativeManifest, type NativeManifest } from './manifest.ts';

type Transport = Awaited<ReturnType<PlatformRuntimeHost['screenRecording']['android']['resolve']>>;

export async function persistNativeManifest(
  transport: Transport,
  manifestPath: string,
  evidence: NativeManifest,
  signal?: AbortSignal,
  create = false,
): Promise<void> {
  const read = await transport.readManifest(manifestPath, signal);
  if (read.status === 'unavailable') throw new Error('Android recording marker unavailable');
  if (create ? read.status !== 'missing' : read.status !== 'read')
    throw new Error('Android recording marker changed');
  if (read.status === 'read') {
    const current = decodeNativeManifest(read.contents);
    if (
      !current ||
      current.fenceToken !== evidence.fenceToken ||
      current.fenceGeneration !== evidence.fenceGeneration ||
      current.claimToken !== evidence.claimToken ||
      current.deviceId !== evidence.deviceId ||
      current.sessionId !== evidence.sessionId ||
      current.launchDisposition === 'canceled'
    )
      throw new Error('Android recording marker ownership changed');
  }
  const outcome = await transport.compareAndSetManifest(
    {
      manifestPath,
      expected: read.status === 'read' ? read.contents : null,
      contents: JSON.stringify(evidence),
    },
    signal,
  );
  if (outcome !== 'updated') throw new Error('Android recording marker update unconfirmed');
}

export async function removeNativeManifest(
  transport: Transport,
  manifestPath: string,
  expected: string,
): Promise<void> {
  const outcome = await transport.compareAndSetManifest({ manifestPath, expected, contents: null });
  if (outcome !== 'updated') throw new Error('Android recording marker removal unconfirmed');
}
