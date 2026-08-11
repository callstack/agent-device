import type { CommandFlags } from '@agent-device/contracts/command';
import { attachRefs, type SnapshotBackend } from '@agent-device/kernel/snapshot';
import {
  makeAndroidSession as makeBaseAndroidSession,
  makeIosSession,
  makeMacOsSession as makeBaseMacOsSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import { makeTestScreenRecordingResource } from '../../../__tests__/test-utils/screen-recording-live-handle.ts';
import type { dispatchCommand } from '../../../core/dispatch.ts';
import { activateCompleteRefFrame } from '../../ref-frame.ts';
import { setSessionSnapshot } from '../../session-snapshot.ts';
import type { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';
import { handleInteractionCommands } from '../interaction.ts';
import { buildSnapshotState } from '../snapshot-capture.ts';

/**
 * Shared factories for the interaction touch handler tests. Named pure
 * factories only: each test file installs and resets its own `vi.mock`s.
 */

export function makeSession(name: string): SessionState {
  return makeIosSession(name);
}

export function makeAndroidSession(name: string): SessionState {
  return makeBaseAndroidSession(name, { appBundleId: 'com.android.settings' });
}

export function makeMacOsDesktopSession(name: string): SessionState {
  return makeBaseMacOsSession(name, { surface: 'desktop' });
}

export function makeMacOsMenubarSession(name: string): SessionState {
  return makeBaseMacOsSession(name, { surface: 'menubar' });
}

export function installTestScreenRecording(
  session: SessionState,
  overrides: Parameters<typeof makeTestScreenRecordingResource>[1] = {},
): void {
  session.screenRecording = makeTestScreenRecordingResource(session, overrides);
}

export function makeVisibleButtonSnapshot(label: string, backend: SnapshotBackend) {
  return buildSnapshotState(
    {
      nodes: [
        { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
        {
          index: 1,
          parentIndex: 0,
          type: 'Button',
          label,
          rect: { x: 10, y: 20, width: 120, height: 44 },
          hittable: true,
        },
      ],
      backend,
    },
    { snapshotInteractiveOnly: false },
  );
}

export const contextFromFlags = (flags: CommandFlags | undefined) => ({
  count: flags?.count,
  intervalMs: flags?.intervalMs,
  delayMs: flags?.delayMs,
  holdMs: flags?.holdMs,
  jitterPx: flags?.jitterPx,
  doubleTap: flags?.doubleTap,
  clickButton: flags?.clickButton,
});

/**
 * Mirrors the real `captureSnapshotForSession` over the calling file's mocked
 * dispatch: session snapshot writes go through `setSessionSnapshot` so the
 * generation advances (#1076 versioned refs).
 */
export function createEmulateCaptureSnapshotForSession(
  mockDispatch: (...args: Parameters<typeof dispatchCommand>) => Promise<unknown>,
) {
  return async function emulateCaptureSnapshotForSession(
    session: SessionState,
    flags: CommandFlags | undefined,
    sessionStore: SessionStore,
    contextFromCallerFlags: (
      flags: CommandFlags | undefined,
      appBundleId?: string,
      traceLogPath?: string,
    ) => Record<string, unknown>,
    options: {
      interactiveOnly: boolean;
      androidFreshnessMode?: 'ref-refresh';
      includeRects?: boolean;
    },
  ) {
    const effectiveFlags = {
      ...(flags ?? {}),
      snapshotInteractiveOnly: options.interactiveOnly,
    };
    const snapshotData = (await mockDispatch(
      session.device,
      'snapshot',
      [],
      effectiveFlags.out,
      contextFromCallerFlags(effectiveFlags, session.appBundleId, session.trace?.outPath),
    )) as { nodes?: never[]; truncated?: boolean; backend?: SnapshotBackend };
    const snapshot = buildSnapshotState(snapshotData ?? {}, effectiveFlags);
    setSessionSnapshot(session, snapshot);
    sessionStore.set(session.name, session);
    return snapshot;
  };
}

// --- Stale @ref warnings (#1076) ---

export function makeTwoButtonNodes() {
  return [
    {
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 390, height: 844 },
    },
    {
      index: 1,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Continue',
      rect: { x: 10, y: 20, width: 100, height: 40 },
      enabled: true,
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'XCUIElementTypeButton',
      label: 'Cancel',
      rect: { x: 10, y: 80, width: 100, height: 40 },
      enabled: true,
      hittable: true,
    },
  ];
}

export function makeStaleRefSession(sessionName: string): SessionState {
  const session = makeSession(sessionName);
  session.snapshot = {
    nodes: attachRefs(makeTwoButtonNodes() as never),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  // As if the snapshot command just returned these refs to the client: a
  // complete, active ref frame (ADR 0014).
  activateCompleteRefFrame(session);
  return session;
}

export async function runInteraction(
  sessionStore: SessionStore,
  sessionName: string,
  command: string,
  positionals: string[],
  flags: Record<string, unknown> = {},
) {
  return await handleInteractionCommands({
    req: { token: 't', session: sessionName, command, positionals, flags },
    sessionName,
    sessionStore,
    contextFromFlags,
  });
}
