import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';
import { isRecord } from '@agent-device/kernel/record';

/** Model the transport's generation-scoped marker address for a native artifact. */
export function androidRecordingMarkerPath(remotePath: string): string {
  const name = path.posix.basename(remotePath);
  const match = /^agent-device-recording-v2-admitted-([a-f0-9]{64})-\d{1,20}\.mp4$/.exec(name);
  if (!match || path.posix.dirname(remotePath) !== '/sdcard')
    throw new Error('Invalid Android recording artifact path');
  return `/sdcard/agent-device-recording-v2-admitted-${match[1]}.json`;
}

/** Model the device-wide admission and exact-marker release contract. */
export function androidRecordingAdmission(markers: Map<string, string>) {
  let owner: string | undefined;
  const acquireAdmission: AndroidScreenRecordingTransport['acquireAdmission'] = async (next) => {
    if (owner !== undefined) return 'busy';
    owner = next;
    return 'acquired';
  };
  const releaseAdmission: AndroidScreenRecordingTransport['releaseAdmission'] = async (input) => {
    if ((markers.get(input.manifestPath) ?? null) !== input.expected) return 'not-owner';
    if (owner === undefined) return 'absent';
    if (owner !== input.owner) return 'not-owner';
    owner = undefined;
    return 'released';
  };
  return {
    acquireAdmission,
    releaseAdmission,
    owns: (expected: string) => owner === expected,
    isHeld: () => owner !== undefined,
  };
}

export function androidRecordingAdmissionOwner(marker: string): string {
  const value: unknown = JSON.parse(marker);
  if (
    !isRecord(value) ||
    typeof value.deviceId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.claimToken !== 'string' ||
    value.claimToken.trim().length === 0 ||
    typeof value.fenceToken !== 'string' ||
    !Number.isInteger(value.fenceGeneration)
  )
    throw new Error('Invalid Android recording admission evidence');
  return createHash('sha256')
    .update(
      JSON.stringify([
        value.deviceId,
        value.sessionId,
        value.claimToken,
        value.fenceToken,
        value.fenceGeneration,
      ]),
    )
    .digest('hex');
}
