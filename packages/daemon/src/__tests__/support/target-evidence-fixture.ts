import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type { SessionState } from '../../core/session-state.ts';
import { authoringPublication, makeIosSession } from './session-factories.ts';

export const SAVE_BUTTON_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'XCUIElementTypeButton',
    identifier: 'save',
    label: 'Save',
    rect: { x: 10, y: 20, width: 100, height: 40 },
    enabled: true,
    hittable: true,
  },
];

/** The `target-v1` evidence the single Save button records. */
export const SAVE_BUTTON_EVIDENCE = {
  id: 'save',
  role: 'button',
  label: 'Save',
  ancestry: [],
  sibling: 0,
  viewportOrder: 0,
  rect: { x: 10, y: 20, width: 100, height: 40 },
  verification: 'verified',
} as const;

/** An iOS app session whose stored snapshot is the Save button, recording or not. */
export function makeSessionWithSaveButtonSnapshot(
  sessionName: string,
  options: { recording: boolean },
): SessionState {
  const session = makeIosSession(sessionName, {
    appBundleId: 'com.example.app',
    ...(options.recording ? { scriptPublication: authoringPublication('armed') } : {}),
  });
  session.snapshot = {
    nodes: attachRefs(SAVE_BUTTON_NODES),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  return session;
}
