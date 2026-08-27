// Vocabulary for the platform-plugin provider facet and the request-scoped provider seam.
//
// `core/platform-plugin/plugin.ts` declares which provider resolvers a platform family gates.
// The concrete resolver table and wrapper composition live in the root composition module; the
// daemon only supplies this neutral request context and consumes the one capability it currently
// needs from the resulting scope.

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SessionSurface } from './session-surface.ts';

export type PlatformProviderRequestSession = Readonly<{
  name: string;
  device: DeviceInfo;
  appBundleId?: string;
  appName?: string;
  surface?: SessionSurface;
}>;

/** Request data shared with a root-composed platform provider resolver. */
export type PlatformProviderRequestContext = Readonly<{
  device: DeviceInfo;
  session?: PlatformProviderRequestSession;
  requestedSession?: string;
  requestId?: string;
  /** Daemon policy says that the root may construct its managed Web provider for this request. */
  useDefaultWebProvider?: boolean;
}>;

/** The only request-scoped platform value currently consumed by daemon handlers.
 *
 * Its concrete Android executor type remains owned by the Android package. The daemon handlers
 * already pass this value through as an opaque capability, so duplicating that package type here
 * would make the seam another declaration site rather than a neutral contract.
 */
export type RequestPlatformProviderScope = Readonly<{
  androidAdbExecutor?: unknown;
}>;

/** Root-composed provider wrappers; device selection remains a daemon policy. */
export type RequestPlatformProviders = Readonly<{
  /** Avoid resolving a daemon device when no resolver or default Web provider is configured. */
  hasConfiguredResolvers: boolean;
  run<T>(
    context: PlatformProviderRequestContext,
    task: (scope: RequestPlatformProviderScope) => Promise<T>,
  ): Promise<T>;
}>;

/**
 * The request provider resolvers whose application is PLATFORM-GATED — each ran behind
 * a hand `device.platform === …` predicate inside its descriptor's `resolve`. The
 * PlatformPlugin `providers` facet (issue #974) declares, per family, which of these
 * apply to that family's devices (data-only: a plain string list, type-only in the
 * plugin), and the root composition routes the gate through it. Resolver invocation,
 * wrapper composition, and request-scope concurrency isolation live with the concrete
 * provider composition, not in daemon request code.
 *
 * App-log and screen-recording transports are deliberately ABSENT: they carry no
 * platform gate (they apply on every platform), so they stay ungated in the daemon and
 * are not part of the facet.
 */
export type PlatformGatedProviderResolverKey =
  | 'androidAdbProvider'
  | 'appleRunnerProvider'
  | 'appleToolProvider'
  | 'vegaToolProvider'
  | 'linuxToolProvider'
  | 'webProvider';
