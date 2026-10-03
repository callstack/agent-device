import type { AppleApplicationState } from '@agent-device/kernel/snapshot';
import type { SessionSurface } from './session-surface.ts';

/**
 * Closed result of the `appstate` command, grounded in the daemon handler's
 * success returns (src/daemon/handlers/session-state.ts `handleAppStateCommand`).
 * A discriminated union on `platform`:
 *  - Apple (`ios` / `macos`) session state, with iOS-only device locators that
 *    the previous hand-written mirror omitted; and
 *  - Android and HarmonyOS foreground `package` / `activity`.
 *
 * The handler returns one of these fixed objects (errors take the `ok: false`
 * path), so each branch is closed.
 */
export type AppStateCommandResult =
  | {
      platform: 'ios' | 'macos';
      appName: string;
      appBundleId?: string;
      /** `runner` when the runner read the session app's state; `session` when only the record answered. */
      source: 'session' | 'runner';
      /**
       * How the session app is running, as the runner reads it; absent with `source: 'session'`.
       * `runningBackground` after `home` says the app left the foreground, not what took it.
       */
      state?: AppleApplicationState;
      surface: SessionSurface;
      /** iOS only — the session device's UDID. */
      device_udid?: string;
      /** iOS only — the simulator set path, or `null` when unknown. */
      ios_simulator_device_set?: string | null;
    }
  | {
      platform: 'android' | 'harmonyos';
      package: string;
      activity: string;
    };
