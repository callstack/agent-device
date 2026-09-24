import type { AppleApplicationState } from '@agent-device/kernel/snapshot';

export type { AppleApplicationState } from '@agent-device/kernel/snapshot';

/** Which app a session-scoped read is about; the Android foreground read needs nothing. */
export type AppStateRuntimeInput = Readonly<{ appBundleId?: string }>;

/** Neutral foreground identity returned by a selected platform/provider runtime. */
export type AppStateRuntimeResult = Readonly<{
  package?: string;
  activity?: string;
  /**
   * Apple: how the app named by the input is running, as a live runner reads it. It says nothing
   * about which app is frontmost; a session app in a background state has left the foreground.
   * Absent when no runner session is live to ask, so the read never starts one.
   */
  applicationState?: AppleApplicationState;
}>;

export type AppStateRuntimeOperations = Readonly<{
  appState(input?: AppStateRuntimeInput): Promise<AppStateRuntimeResult>;
}>;
