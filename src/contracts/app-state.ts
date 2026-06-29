import type { SessionSurface } from '../core/session-surface.ts';

/**
 * Closed result of the `appstate` command, grounded in the daemon handler's
 * success returns (src/daemon/handlers/session-state.ts `handleAppStateCommand`).
 * A discriminated union on `platform`:
 *  - Apple (`ios` / `macos`) session state, with iOS-only device locators that
 *    the previous hand-written mirror omitted; and
 *  - Android foreground `package` / `activity`.
 *
 * The handler returns one of these fixed objects (errors take the `ok: false`
 * path), so each branch is closed.
 */
export type AppStateCommandResult =
  | {
      platform: 'ios' | 'macos';
      appName: string;
      appBundleId?: string;
      source: 'session';
      surface: SessionSurface;
      /** iOS only — the session device's UDID. */
      device_udid?: string;
      /** iOS only — the simulator set path, or `null` when unknown. */
      ios_simulator_device_set?: string | null;
    }
  | {
      platform: 'android';
      package: string;
      activity: string;
    };
