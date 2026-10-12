import {
  buildIosSnapshotPresentationKey,
  createIosSnapshotRequest,
  iosSnapshotComparisonIdentityKey,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type { IosSnapshotComparisonIdentity } from '@agent-device/contracts/ios-snapshot';
import { IOS_SYSTEM_SURFACE_HOSTS } from '@agent-device/contracts/ios-system-surface';

/**
 * The comparison identity the iOS snapshot route stamps on a capture it served from the XCTest
 * runner, built through the production key function: an app capture is lineaged to the app, a
 * capture of an in-place system surface (a web sign-in sheet) to its HOST, because that is the
 * surface it describes (#2438). Regressions that rely on a cross-surface pair being incomparable
 * build both here, so they fail if the construction ever stops distinguishing them. A test that
 * needs both halves of one capture — a stored baseline keyed from it, and a capture result carrying
 * it — takes the identity rather than rewriting the shape (#3510).
 */
export function appCaptureComparisonIdentity(
  deviceId: string,
  appBundleId: string,
): IosSnapshotComparisonIdentity {
  return runnerComparisonIdentity(`${deviceId}:${appBundleId}`);
}

export function appCaptureComparisonKey(deviceId: string, appBundleId: string): string {
  return iosSnapshotComparisonIdentityKey(appCaptureComparisonIdentity(deviceId, appBundleId));
}

export function systemSurfaceCaptureComparisonKey(deviceId: string): string {
  return iosSnapshotComparisonIdentityKey(
    runnerComparisonIdentity(`${deviceId}:${IOS_SYSTEM_SURFACE_HOSTS[0]!.bundleId}`),
  );
}

function runnerComparisonIdentity(targetId: string): IosSnapshotComparisonIdentity {
  return {
    producer: 'apple-runner',
    intent: 'full',
    lineage: { targetId },
    presentationKey: buildIosSnapshotPresentationKey(createIosSnapshotRequest()),
    residue: [{ kind: 'fallback-source', producer: 'apple-runner' }],
  };
}
