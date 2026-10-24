import { ensureNetworkCaptureProbe } from './probe-cache.ts';

/** The environment key the capture probe reads to find the file it writes (ADR 0037). */
export const NETWORK_CAPTURE_PATH_ENV = 'AGENT_DEVICE_NETWORK_CAPTURE_PATH';

/** The dyld injection key the simulator hands to the app process. */
const DYLD_INSERT_LIBRARIES_ENV = 'DYLD_INSERT_LIBRARIES';

/** Prefix `xcrun simctl launch` strips to build the launched app's own environment. */
const SIMCTL_CHILD_PREFIX = 'SIMCTL_CHILD_';

/** One open that asked for network capture: the host file the probe must write. */
export type AppleNetworkCaptureLaunch = Readonly<{ capturePath: string }>;

/** Builds the probe a capture launch injects; overridable so a test drives the failure path. */
export type NetworkCaptureProbeBuilder = (
  signal: AbortSignal | undefined,
) => Promise<Readonly<{ path: string }>>;

/**
 * The `xcrun simctl launch` environment overrides that put the capture probe inside the app
 * process, or `undefined` when the caller asked for no capture. The runner merges them over the
 * host environment at the spawn boundary.
 *
 * Only these two variables reach the app: `simctl launch` starts the app with a clean environment
 * of its own and forwards nothing of the parent's except the `SIMCTL_CHILD_`-prefixed names it
 * strips and hands over, so this adds capture without changing what the app otherwise sees. The
 * probe exits silently when its path variable is absent, which keeps the dylib inert on any launch
 * that does not name a capture file.
 *
 * When the probe cannot be built, its typed build failure is rethrown: an open that asked for
 * capture must not silently launch without it.
 */
export async function buildNetworkCaptureLaunchEnv(
  capture: AppleNetworkCaptureLaunch | undefined,
  signal?: AbortSignal,
  buildProbe: NetworkCaptureProbeBuilder = async (probeSignal) =>
    await ensureNetworkCaptureProbe({ signal: probeSignal }),
): Promise<Record<string, string> | undefined> {
  if (!capture) return undefined;
  const probe = await buildProbe(signal);
  const env: Record<string, string> = {};
  env[`${SIMCTL_CHILD_PREFIX}${DYLD_INSERT_LIBRARIES_ENV}`] = probe.path;
  env[`${SIMCTL_CHILD_PREFIX}${NETWORK_CAPTURE_PATH_ENV}`] = capture.capturePath;
  return env;
}
