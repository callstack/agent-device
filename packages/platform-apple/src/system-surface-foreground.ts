import {
  IOS_SYSTEM_SURFACE_HOSTS,
  type IosSystemSurfaceHost,
} from '@agent-device/contracts/ios-system-surface';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isAppleApplicationState } from '@agent-device/kernel/snapshot';
import { readRunnerSessionLiveness, runAppleRunnerCommand } from './core/runner-client.ts';

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

export type SystemSurfaceForegroundProbe = (
  device: DeviceInfo,
  input: Readonly<{ signal: AbortSignal; requestId?: string }>,
) => Promise<SystemSurfaceForegroundReading>;

/**
 * Bounds each read below the read-only resend window, so a runner busy draining abandoned XCTest
 * work costs this capture at most the bound and then the runner route it would have taken anyway.
 */
const HOST_STATE_READ_TIMEOUT_MS = 1_000;

const BACKGROUND_STATES: ReadonlySet<string> = new Set([
  'notRunning',
  'runningBackground',
  'runningBackgroundSuspended',
]);

/**
 * The runner session the reads go to, or `undefined` when no runner can answer. The session id makes
 * each read refuse a replacement runner.
 */
export type ForegroundProbeSession = (
  device: DeviceInfo,
  input: Readonly<{ signal: AbortSignal; requestId?: string }>,
) => Promise<Readonly<{ sessionId: string }> | undefined>;

/**
 * The local session: a ready runner in the session registry. The read never starts a runner: with no
 * ready runner the route asks the bridge to check the surface hosts itself.
 */
const readyLocalSession: ForegroundProbeSession = async (device) => {
  const session = readRunnerSessionLiveness(device.id);
  return session?.liveness === 'ready' ? { sessionId: session.sessionId } : undefined;
};

export function createSystemSurfaceForegroundProbe(
  readySession: ForegroundProbeSession = readyLocalSession,
): SystemSurfaceForegroundProbe {
  return async (device, input) => {
    const session = await readySession(device, input);
    if (!session) return { foreground: 'unknown' };
    // The reads go out together: each one is a runner round trip, which costs a network hop to a
    // remote Simulator. The answer reads them in registry order, so a decisive state settles it
    // without waiting for the hosts after it.
    const reads = IOS_SYSTEM_SURFACE_HOSTS.map((host) =>
      readHostState(device, host.bundleId, session.sessionId, input),
    );
    // A read the answer no longer waits for rejects only when the request is cancelled.
    for (const read of reads) read.catch(() => {});
    for (const [index, host] of IOS_SYSTEM_SURFACE_HOSTS.entries()) {
      const state = await reads[index];
      if (state === 'runningForeground')
        return { foreground: { kind: 'foreground', host }, sessionId: session.sessionId };
      if (state === undefined || !BACKGROUND_STATES.has(state))
        return { foreground: 'unknown', sessionId: session.sessionId };
    }
    return { foreground: 'background', sessionId: session.sessionId };
  };
}

async function readHostState(
  device: DeviceInfo,
  bundleId: string,
  runnerSessionId: string,
  input: Readonly<{ signal: AbortSignal; requestId?: string }>,
): Promise<string | undefined> {
  try {
    // `appState` brings no app forward and binds nothing: it reads the named bundle's
    // `XCUIApplication.state`, the predicate the runner itself uses to serve a surface in place.
    // The expected session id refuses a replacement runner, so the read cannot start or restart one.
    const result = await runAppleRunnerCommand(
      device,
      { command: 'appState', appBundleId: bundleId },
      {
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(HOST_STATE_READ_TIMEOUT_MS)]),
        expectedRunnerSessionId: runnerSessionId,
        ...(input.requestId ? { requestId: input.requestId } : {}),
      },
    );
    const state = result.applicationState;
    return isAppleApplicationState(state) ? state : undefined;
  } catch {
    input.signal.throwIfAborted();
    return undefined;
  }
}
