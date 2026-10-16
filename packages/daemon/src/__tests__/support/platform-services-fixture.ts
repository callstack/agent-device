import { type ClaimRecoveryGatewayFactory } from '@agent-device/daemon-contracts/device-claim-recovery';
import { vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { DeviceBootObservation } from '@agent-device/contracts/device-boot';
import type { DaemonPlatformServices } from '../../core/platform-services.ts';
import { unavailableDeviceRuntimeGateway } from './unavailable-device-runtime-gateway.ts';

/**
 * The `DaemonPlatformServices` port as the daemon suites answer it: every member is a plain
 * `vi.fn` spy with a canned answer, never a re-implementation of a root platform rule. A suite
 * that cares about one ask overrides just that member — per case through the `overrides`
 * argument, or by mocking this module's exported spy — and asserts the daemon's branching on
 * the answer. What the composed members actually do (surface, open-target, readiness, and boot
 * rules over the platform packages) is owned by the composition lane, which builds the real
 * port through `src/__tests__/daemon-composition/platform-services-fixture.ts`. Members are
 * module-level stable references so two fixture instances deep-compare equal.
 */
export function daemonPlatformServicesFixture(
  overrides: Partial<DaemonPlatformServices> = {},
): DaemonPlatformServices {
  return Object.freeze({
    appleSessionObservation: Object.freeze({
      observeRunnerSession: observeRunnerSessionFixture,
      resolveSoleForegroundApp: resolveSoleForegroundAppFixture,
    }),
    deviceBootObservation: Object.freeze({
      observeBootTimeMs: observeBootTimeMsFixture,
    }),
    ensureLocalDeviceReady: ensureLocalDeviceReadyFixture,
    resolveRequestedOpenSurface: resolveRequestedOpenSurfaceFixture,
    validateOpenRelaunchTarget: validateOpenRelaunchTargetFixture,
    resolveSessionAppBundleIdForTarget: resolveSessionAppBundleIdForTargetFixture,
    ...overrides,
  });
}

/** The canned runner-session observation: no live runner on any device. */
const observeRunnerSessionFixture = vi.fn(async (_deviceId: string) => undefined);

/** The canned foreground answer: nothing observable to name a sole foreground app. */
const resolveSoleForegroundAppFixture = vi.fn(
  async (_params: Readonly<{ simulatorSetPath?: string }>) => undefined,
);

/**
 * The canned boot answer: the boot moment stays unobserved, which keeps callers as cautious as
 * an unanswered probe leaves them. The unobserved-vs-unsupported split the real observation
 * reports per device family is pinned in the composition lane.
 */
export const observeBootTimeMsFixture = vi.fn(
  async (_device: DeviceInfo): Promise<DeviceBootObservation> =>
    ({ observed: false, reason: 'unobserved' }) as const,
);

/** The canned readiness answer: local readiness succeeds; a suite rejects this to fail an open. */
const ensureLocalDeviceReadyFixture = vi.fn(async (_device: DeviceInfo) => true);

/**
 * The canned surface answer: no platform validation, just the session's own surface carried
 * forward or `app`. Suites needing another surface pass one through `overrides`. The macOS and
 * Linux surface rules are pinned in the composition lane.
 */
const resolveRequestedOpenSurfaceFixture = vi.fn(
  (params: {
    device: DeviceInfo;
    surfaceFlag: string | undefined;
    openTarget: string | undefined;
    existingSurface?: SessionSurface;
  }): SessionSurface => params.existingSurface ?? 'app',
);

/** The canned relaunch answer: every requested relaunch target is acceptable. */
const validateOpenRelaunchTargetFixture = vi.fn(
  async (_params: {
    target: string | undefined;
    platform: string | undefined;
    surface?: SessionSurface;
  }) => undefined,
);

/**
 * The canned open-target answer: target resolution changes no identity — the session keeps its
 * current app. Suites asserting a resolved bundle id answer per case; the resolution rules live
 * in `src/platform-runtime-open-target.test.ts`.
 */
export const resolveSessionAppBundleIdForTargetFixture = vi.fn(
  async (
    _device: DeviceInfo,
    _openTarget: string | undefined,
    currentAppBundleId: string | undefined,
  ): Promise<string | undefined> => currentAppBundleId,
);

/**
 * The claim-recovery gateway factory port: recovery transactions in daemon suites get a gateway
 * that binds nothing and reports every owner unavailable, because the suites assert the
 * transaction's decisions (retain, settle, refuse) around the gateway, not what a composed
 * platform gateway does on the device. `vi.fn` per call so a suite can count compositions and
 * hand its own unavailable bindings where recovery must proceed.
 */
export function daemonClaimRecoveryGatewayFixture(): ClaimRecoveryGatewayFactory {
  return vi.fn(() => unavailableDeviceRuntimeGateway);
}
