import type { SnapshotState } from '@agent-device/kernel/snapshot';
import { systemSurfaceDisclosure } from '@agent-device/contracts/android-system-surface-disclosure';
import { IOS_SYSTEM_SURFACE_DISCLOSURE } from '@agent-device/contracts/ios-system-surface';
import type { DaemonResponse } from './daemon-request.ts';

/**
 * Append the occluding-system-surface disclosure to a selector-route response whose consumed
 * snapshot was a system surface: an Android notification shade / quick settings, or an iOS in-place
 * web sign-in sheet (#2438). Both found and not-found outcomes must explain that app content is
 * occluded: a match found inside the surface is not app content, and a miss is expected while the
 * surface covers the app.
 */
export function withSystemSurfaceDisclosure(
  response: DaemonResponse,
  snapshot: Pick<SnapshotState, 'systemSurfaceOnly' | 'iosSystemSurfaceBundleId'> | undefined,
): DaemonResponse {
  const disclosure = snapshot?.iosSystemSurfaceBundleId
    ? IOS_SYSTEM_SURFACE_DISCLOSURE
    : systemSurfaceDisclosure(snapshot);
  if (!disclosure) return response;
  if (response.ok) {
    const warning = appended(response.data?.warning, disclosure);
    return { ...response, data: { ...response.data, warning } };
  }
  const details = response.error.details ?? {};
  return {
    ...response,
    error: { ...response.error, details: { ...details, hint: appended(details.hint, disclosure) } },
  };
}

function appended(existing: unknown, disclosure: string): string {
  return typeof existing === 'string' && existing.trim() !== ''
    ? `${existing}\n${disclosure}`
    : disclosure;
}
