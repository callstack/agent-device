import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

/**
 * One presented iOS `pageSheet`, in the two flavours a settle baseline can arrive as, plus the app
 * screen a dismissal returns to. An interactive capture carries only the surface — the content
 * underneath is not hittable, so it drops out of the projection (4 nodes on the iPhone 18 Pro sim,
 * October 2026) — while a full read of the very same screen also reports the covered content (6
 * nodes). Arming the broad-transition confirmation must not depend on which flavour produced the
 * baseline, which is what the caller that reads these asserts.
 */
export const PRESENTED_SHEET_INTERACTIVE_NODES: RawSnapshotNode[] = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'StaticText',
    label: 'Allow notifications?',
    rect: { x: 10, y: 450, width: 370, height: 22 },
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'Button',
    label: 'Continue',
    rect: { x: 10, y: 600, width: 370, height: 44 },
    hittable: true,
  },
  {
    index: 3,
    parentIndex: 0,
    type: 'Button',
    label: 'Cancel',
    rect: { x: 10, y: 660, width: 370, height: 44 },
    hittable: true,
  },
];

export const PRESENTED_SHEET_FULL_NODES: RawSnapshotNode[] = [
  ...PRESENTED_SHEET_INTERACTIVE_NODES,
  {
    index: 4,
    parentIndex: 0,
    type: 'Other',
    label: 'CoveredContent',
    rect: { x: 0, y: 0, width: 390, height: 440 },
  },
  {
    index: 5,
    parentIndex: 0,
    type: 'Button',
    label: 'Open settings',
    rect: { x: 10, y: 120, width: 370, height: 44 },
  },
];

/** The app screen the sheet is dismissed from, which is what every settle capture then reads. */
export const SHEET_DISMISSED_NODES: RawSnapshotNode[] = [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
  {
    index: 1,
    parentIndex: 0,
    type: 'StaticText',
    label: 'Signed in as demo',
    rect: { x: 10, y: 80, width: 200, height: 22 },
  },
  {
    index: 2,
    parentIndex: 0,
    type: 'Button',
    label: 'Home',
    rect: { x: 10, y: 120, width: 370, height: 44 },
    hittable: true,
  },
  {
    index: 3,
    parentIndex: 0,
    type: 'TabBar',
    label: 'Tab Bar',
    rect: { x: 0, y: 800, width: 390, height: 44 },
  },
];
