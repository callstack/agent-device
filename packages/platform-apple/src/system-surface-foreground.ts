import {
  IOS_SYSTEM_SURFACE_HOSTS,
  type IosSystemSurfaceHost,
} from '@agent-device/contracts/ios-system-surface';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { isAppleApplicationState } from '@agent-device/kernel/snapshot';
import { readRunnerSessionLiveness, runAppleRunnerCommand } from './core/runner-client.ts';

/**
 * Whether any registered iOS system surface host is on screen, asked of the device's live runner
 * (#2438). The host-side process probe only proves a host process exists, and a host outlives what
 * it presented: password AutoFill at sign-in leaves `SafariViewService` running for the rest of the
 * session, which sent every later capture of the app to XCTest. On a deep tree such as Bluesky's feed
 * that capture costs 3-8s, where the host AX bridge answers in about 200ms.
 *
 * `background` is the only answer that may send a capture to the bridge, and it needs every
 * registered host to report a state other than foreground: one host lingering in the background says
 * nothing about another presenting. A foreground host names itself, and the capture takes the runner
 * route that serves it. `unknown` leaves the decision to the host-side process probe.
 */
export type SystemSurfaceForeground =
  | Readonly<{ kind: 'foreground'; host: IosSystemSurfaceHost }>
  | 'background'
  | 'unknown';

export type SystemSurfaceForegroundProbe = (
  device: DeviceInfo,
  input: Readonly<{ signal: AbortSignal; requestId?: string }>,
) => Promise<SystemSurfaceForeground>;

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

export function createSystemSurfaceForegroundProbe(): SystemSurfaceForegroundProbe {
  return async (device, input) => {
    const session = readRunnerSessionLiveness(device.id);
    // The read never starts a runner: with no ready runner the route asks the process probe.
    if (!session || session.liveness !== 'ready') return 'unknown';
    for (const host of IOS_SYSTEM_SURFACE_HOSTS) {
      const state = await readHostState(device, host.bundleId, session.sessionId, input);
      if (state === 'runningForeground') return { kind: 'foreground', host };
      if (state === undefined || !BACKGROUND_STATES.has(state)) return 'unknown';
    }
    return 'background';
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
