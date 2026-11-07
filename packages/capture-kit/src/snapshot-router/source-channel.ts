import type { IosSnapshotAcquisition } from '@agent-device/contracts/ios-snapshot';
import type { IosSystemSurfaceHost } from '@agent-device/contracts/ios-system-surface';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

/**
 * The vocabulary a snapshot source channel speaks to the router: what an acquisition returns, the
 * typed refusal it throws, and the surface foreground reading that decides whether the capture
 * stays on the channel. It imports no platform or provider code, so a platform's source can carry
 * it without loading the router.
 */

export type SnapshotSourceFailureKind =
  | 'unsupported'
  | 'malformed-tree'
  | 'stale-target'
  | 'timeout'
  | 'cancelled'
  | 'process-crash'
  | 'transport-failure'
  /** The bridge binary is still being prepared by a detached attempt; nothing failed. */
  | 'preparing';

export type SnapshotSourceFailure = Readonly<{
  kind: SnapshotSourceFailureKind;
  code: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export type SnapshotSourceOutcome =
  | Readonly<{ stage: 'acquired'; acquisition: IosSnapshotAcquisition }>
  | Readonly<{
      stage: 'failed';
      failure: SnapshotSourceFailure;
    }>;

const APP_ERROR_CODE_BY_KIND: Readonly<Record<SnapshotSourceFailureKind, string>> = {
  unsupported: 'UNSUPPORTED_OPERATION',
  'malformed-tree': 'COMMAND_FAILED',
  'stale-target': 'COMMAND_FAILED',
  timeout: 'COMMAND_FAILED',
  cancelled: 'COMMAND_FAILED',
  'process-crash': 'COMMAND_FAILED',
  'transport-failure': 'COMMAND_FAILED',
  preparing: 'COMMAND_FAILED',
};

/** A typed source refusal. The router classifies one thrown by target resolution by its kind and code. */
export class SnapshotSourceError extends AppError {
  readonly failureKind: SnapshotSourceFailureKind;
  readonly failureCode: string;

  constructor(
    kind: SnapshotSourceFailureKind,
    code: string,
    message = `iOS Simulator snapshot source ${kind}: ${code}`,
    details: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
  ) {
    super(
      APP_ERROR_CODE_BY_KIND[kind],
      message,
      {
        ...details,
        bridgeFailure: kind,
        bridgeFailureCode: code,
        ...(kind === 'cancelled' ? { reason: 'request_canceled' } : {}),
      },
      cause,
    );
    this.name = 'SnapshotSourceError';
    this.failureKind = kind;
    this.failureCode = code;
  }
}

/**
 * Whether any registered iOS system surface host is on screen, asked of the device's live runner
 * (#2438). The bridge's process check only proves a host process exists, and a host outlives what
 * it presented: password AutoFill at sign-in leaves `SafariViewService` running for the rest of the
 * session, which sent every later capture of the app to XCTest. On a deep tree such as Bluesky's feed
 * that capture costs 3-8s, where the host AX bridge answers in about 200ms.
 *
 * `background` is the only answer that may send a capture to the bridge, and it needs every
 * registered host to report a state other than foreground: one host lingering in the background says
 * nothing about another presenting. A foreground host names itself, and the capture takes the runner
 * route that serves it. `unknown` leaves the decision to the bridge's process check.
 */
export type SystemSurfaceForeground =
  | Readonly<{ kind: 'foreground'; host: IosSystemSurfaceHost }>
  | 'background'
  | 'unknown';

/** One foreground read, with the runner session it was read through when that session is known. */
export type SystemSurfaceForegroundReading = Readonly<{
  foreground: SystemSurfaceForeground;
  sessionId?: string;
}>;

/** The surface proof for one capture. The router reads it on every capture and never caches it. */
export type SystemSurfaceForegroundProbe = (
  device: DeviceInfo,
  input: Readonly<{ signal: AbortSignal; requestId?: string }>,
) => Promise<SystemSurfaceForegroundReading>;
