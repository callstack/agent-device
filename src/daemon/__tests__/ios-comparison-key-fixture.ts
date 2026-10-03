import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  iosSnapshotComparisonIdentityKey,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';

/**
 * The comparison keys the iOS snapshot route stamps on XCTest captures, built through the production
 * key function: an app capture is lineaged to the app, a capture of an in-place system surface (a web
 * sign-in sheet) to its HOST, because that is the surface it describes (#2438). Regressions that rely
 * on a cross-surface pair being incomparable build both keys here, so they fail if the construction
 * ever stops distinguishing them.
 */
export function appCaptureComparisonKey(deviceId: string, appBundleId: string): string {
  return runnerComparisonKey(`${deviceId}:${appBundleId}`);
}

export function systemSurfaceCaptureComparisonKey(deviceId: string): string {
  return runnerComparisonKey(`${deviceId}:${IOS_SYSTEM_SURFACE_HOSTS[0]!.bundleId}`);
}

function runnerComparisonKey(targetId: string): string {
  return iosSnapshotComparisonIdentityKey({
    producer: 'apple-runner',
    intent: 'full',
    lineage: { targetId },
    presentationKey: buildIosSnapshotPresentationKey(createIosSnapshotRequest()),
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  });
}
