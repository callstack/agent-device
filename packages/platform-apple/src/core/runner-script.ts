import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * What the native build scripts (`pnpm build:xcuitest:<platform>`, `clean:xcuitest`) need to speak
 * `DeviceInfo` and the build-output layout. The runner package owns the cache identity those scripts
 * record; this module owns the script-side platform vocabulary, so the runner entry carries none of it.
 */

const RUNNER_XCUITEST_SCRIPT_PLATFORMS = ['ios', 'macos', 'tvos', 'visionos'] as const;
export type RunnerXcuitestScriptPlatform = (typeof RUNNER_XCUITEST_SCRIPT_PLATFORMS)[number];

export function isRunnerXcuitestScriptPlatform(
  value: string,
): value is RunnerXcuitestScriptPlatform {
  return (RUNNER_XCUITEST_SCRIPT_PLATFORMS as readonly string[]).includes(value);
}

const RUNNER_SCRIPT_TARGET: Record<
  RunnerXcuitestScriptPlatform,
  NonNullable<DeviceInfo['target']>
> = {
  ios: 'mobile',
  macos: 'desktop',
  tvos: 'tv',
  visionos: 'mobile',
};

const RUNNER_SCRIPT_APPLE_OS: Record<
  RunnerXcuitestScriptPlatform,
  NonNullable<DeviceInfo['appleOs']>
> = {
  ios: 'ios',
  macos: 'macos',
  tvos: 'tvos',
  visionos: 'visionos',
};

/**
 * The device a build-script invocation stands in for: the script names its platform as a
 * literal and a destination string, and the cache metadata owner speaks `DeviceInfo`.
 * Resolving identity through this one mapping keeps a script-written manifest comparable to
 * the metadata a daemon resolves for the same build.
 */
export function resolveRunnerScriptDevice(
  platform: RunnerXcuitestScriptPlatform,
  destination: string,
): DeviceInfo {
  return {
    platform: 'apple',
    id: `runner-script-${platform}`,
    name: `Apple runner build script (${platform})`,
    kind: platform === 'macos' ? 'device' : resolveRunnerScriptDestinationKind(destination),
    target: RUNNER_SCRIPT_TARGET[platform],
    appleOs: RUNNER_SCRIPT_APPLE_OS[platform],
  };
}

/**
 * Whether an `xcodebuild -destination` string names a simulator, read from its `platform=` token
 * rather than a substring of the whole string: `xcodebuild` accepts `platform=iOS simulator` in
 * any casing, and a destination that merely happens to contain the word would otherwise certify a
 * simulator-SDK build under a physical-device identity that agrees with it key for key.
 *
 * A destination with no `platform=` token — a bare `id=<UDID>` works for `xcodebuild` — leaves the
 * SDK choice to the scheme, so no identity can be recorded for it and the build is refused.
 */
function resolveRunnerScriptDestinationKind(destination: string): DeviceInfo['kind'] {
  const platformToken = readDestinationPlatformToken(destination);
  if (platformToken === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'The Apple runner build destination must name its platform',
      {
        destination,
        hint: 'Pass a destination with a platform= token, e.g. generic/platform=iOS Simulator for a simulator or generic/platform=iOS for a physical device.',
      },
    );
  }
  const named = platformToken.toLowerCase();
  return named.endsWith('simulator') ? 'simulator' : 'device';
}

function readDestinationPlatformToken(destination: string): string | undefined {
  for (const clause of destination.split(',')) {
    const separator = clause.indexOf('=');
    if (separator < 0) continue;
    const key = clause
      .slice(0, separator)
      .trim()
      .toLowerCase()
      .replace(/^generic\//, '');
    if (key === 'platform') {
      return clause.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}

/**
 * The derived-data directory `pnpm build:xcuitest:<platform>` builds into when no override is set.
 * iOS builds into the shared base; the other platforms build into a subdirectory of it. The base
 * is the one `scripts/build-xcuitest-apple.sh` defaults to under the given home directory.
 */
export function resolveRunnerScriptDefaultDerivedPath(
  platform: RunnerXcuitestScriptPlatform,
  homeDirectory: string,
): string {
  const base = path.join(homeDirectory, '.agent-device', 'apple-runner', 'derived');
  return platform === 'ios' ? base : path.join(base, platform);
}
