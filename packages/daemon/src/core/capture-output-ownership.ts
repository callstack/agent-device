import type { DaemonArtifact, DaemonResponseData } from '@agent-device/kernel/contracts';

const CAPTURE_OUTPUT_OWNERSHIP = Symbol('captureOutputOwnership');
type CaptureOutputOwnership = 'daemon' | 'caller';
type CaptureOutputOwner = Readonly<{
  ownership: CaptureOutputOwnership;
  tenantId?: string;
  /** Null records an unleased producer. Undefined leaves ownership to the request. */
  leaseVerifier?: string | null;
}>;
type CaptureOutputData = DaemonResponseData & {
  [CAPTURE_OUTPUT_OWNERSHIP]?: CaptureOutputOwner;
};

/** Producer-owned capture facts stay private when the response is serialized. */
export function withCaptureOutputOwnership(
  data: DaemonResponseData,
  ownership: CaptureOutputOwnership,
  tenantId?: string,
  leaseVerifier?: string | null,
): DaemonResponseData {
  return { ...data, [CAPTURE_OUTPUT_OWNERSHIP]: { ownership, tenantId, leaseVerifier } };
}

export function captureOutputOwnership(
  data: DaemonResponseData,
): CaptureOutputOwnership | undefined {
  const capture: CaptureOutputData = data;
  return capture[CAPTURE_OUTPUT_OWNERSHIP]?.ownership;
}

export function captureOutputTenantId(data: DaemonResponseData): string | undefined {
  const capture: CaptureOutputData = data;
  return capture[CAPTURE_OUTPUT_OWNERSHIP]?.tenantId;
}

export function captureOutputLeaseVerifier(data: DaemonResponseData): string | null | undefined {
  const capture: CaptureOutputData = data;
  return capture[CAPTURE_OUTPUT_OWNERSHIP]?.leaseVerifier;
}

const DAEMON_DELIVERED_ARTIFACT = Symbol('daemonDeliveredArtifact');
type DeliveredArtifact = DaemonArtifact & {
  [DAEMON_DELIVERED_ARTIFACT]?: Readonly<{ tenantId: string | undefined }>;
};

/**
 * Marks an artifact the daemon produced for the caller itself, such as a remote recording's script
 * version. It is registered for download for `tenantId` alone, whatever the request's tenant,
 * capture filters, or network marker say. The mark stays private when the response is serialized.
 */
export function asDaemonDeliveredArtifact(
  artifact: DaemonArtifact,
  tenantId: string | undefined,
): DaemonArtifact {
  const delivered: DeliveredArtifact = artifact;
  delivered[DAEMON_DELIVERED_ARTIFACT] = { tenantId };
  return delivered;
}

/** The delivery of a daemon-delivered artifact, or `undefined` for any other artifact. */
export function daemonDeliveredArtifact(
  artifact: DaemonArtifact | undefined,
): Readonly<{ tenantId: string | undefined }> | undefined {
  const delivered: DeliveredArtifact | undefined = artifact;
  return delivered?.[DAEMON_DELIVERED_ARTIFACT];
}

const SCREENSHOT_DELIVERY_PATH = Symbol('screenshotDeliveryPath');
type ScreenshotDeliveryData = DaemonResponseData & {
  [SCREENSHOT_DELIVERY_PATH]?: string;
};

/** Keeps the actual file available to nested commands until the HTTP reply is written. */
export function withScreenshotDeliveryPath<T extends DaemonResponseData>(
  data: T,
  deliveryPath: string,
): T {
  return { ...data, [SCREENSHOT_DELIVERY_PATH]: deliveryPath };
}

export function screenshotWireData(data: DaemonResponseData): DaemonResponseData {
  const screenshot: ScreenshotDeliveryData = data;
  const deliveryPath = screenshot[SCREENSHOT_DELIVERY_PATH];
  if (deliveryPath === undefined) return data;
  return {
    ...data,
    path: deliveryPath,
    ...(data.message === undefined ? {} : { message: `Saved screenshot: ${deliveryPath}` }),
  };
}
