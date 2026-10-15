import type { IosTreeNode } from './snapshot.ts';

/**
 * Trees shaped from live Limrun iOS instances (issue #3349 evidence). The shapes are what the
 * detection rules are actually tested against, so each keeps the provider's real fields:
 * `role`/`type` pairs, `AXLabel`, per-node `pid`, and a `frame` dictionary.
 *
 * The captured discriminator: a system alert arrives as its own `AXApplication` root whose
 * `AXLabel` is blank and whose `pid` (and every child's `pid`) is the hosting process, not the
 * app's. The app's own `UIAlertController` arrives inside the app's root with the app's `pid`.
 */

/** The app under test, as the app's own root reports it. */
export const LIMRUN_APP_PID = 59_012;
/** The process hosting system alerts (SpringBoard's alert agent on the instance). */
export const LIMRUN_ALERT_HOST_PID = 24_261;
/** SpringBoard, which contributes the status-bar nodes that ride along on app screens. */
export const LIMRUN_SPRINGBOARD_PID = 33_887;

export const LIMRUN_ALERT_SCREEN: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 402,
  height: 874,
});

function alertRoot(children: IosTreeNode[]): IosTreeNode {
  return {
    type: 'Application',
    role: 'AXApplication',
    AXLabel: ' ',
    pid: LIMRUN_ALERT_HOST_PID,
    frame: { x: 0, y: 0, ...LIMRUN_ALERT_SCREEN },
    traits: ['None'],
    children,
  };
}

/** Positive control: the live ATT prompt tree — its own root, host pid, two texts, two buttons. */
export function limrunAttAlertTree(): IosTreeNode {
  return alertRoot([
    {
      type: 'StaticText',
      role: 'AXStaticText',
      AXLabel: 'Allow “ATTProbe” to track your activity across other companies’ apps and websites?',
      pid: LIMRUN_ALERT_HOST_PID,
      frame: { x: 71, y: 381.33, width: 260, height: 64.33 },
      traits: ['Scrollable', 'StaticText'],
    },
    {
      type: 'StaticText',
      role: 'AXStaticText',
      AXLabel: 'This build asks for tracking authorization once, for automation testing.',
      pid: LIMRUN_ALERT_HOST_PID,
      frame: { x: 71, y: 453.33, width: 260, height: 38 },
      traits: ['Scrollable', 'StaticText'],
    },
    {
      type: 'Button',
      role: 'AXButton',
      AXLabel: 'Ask App Not to Track',
      pid: LIMRUN_ALERT_HOST_PID,
      enabled: true,
      frame: { x: 57, y: 511.67, width: 288, height: 48 },
      traits: ['Button', 'Scrollable'],
    },
    {
      type: 'Button',
      role: 'AXButton',
      AXLabel: 'Allow',
      pid: LIMRUN_ALERT_HOST_PID,
      enabled: true,
      frame: { x: 57, y: 567.67, width: 288, height: 48 },
      traits: ['Button', 'Scrollable'],
    },
  ]);
}

/** The same alert with its buttons removed: a text sheet is not an actionable alert. */
export function limrunAlertTreeWithoutButtons(): IosTreeNode {
  const root = limrunAttAlertTree();
  return { ...root, children: (root.children ?? []).filter((n) => n.role !== 'AXButton') };
}

/** An alert whose only choices are ambiguous: no label classifies as accept or dismiss. */
export function limrunAlertAmbiguousButtonsTree(): IosTreeNode {
  const root = limrunAttAlertTree();
  return {
    ...root,
    children: [
      ...(root.children ?? []).slice(0, 2),
      {
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'Maybe Later',
        pid: LIMRUN_ALERT_HOST_PID,
        enabled: true,
        frame: { x: 57, y: 511.67, width: 288, height: 48 },
        traits: ['Button', 'Scrollable'],
      },
      {
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'More Info',
        pid: LIMRUN_ALERT_HOST_PID,
        enabled: true,
        frame: { x: 57, y: 567.67, width: 288, height: 48 },
        traits: ['Button', 'Scrollable'],
      },
    ],
  };
}

/** The live app home screen: app root with the app pid, plus SpringBoard status-bar nodes. */
export function limrunAppScreenTree(): IosTreeNode {
  return {
    type: 'Application',
    role: 'AXApplication',
    AXLabel: 'ATTProbe',
    pid: LIMRUN_APP_PID,
    frame: { x: 0, y: 0, ...LIMRUN_ALERT_SCREEN },
    traits: ['None'],
    children: [
      {
        type: 'StaticText',
        role: 'AXStaticText',
        AXLabel: 'ATT Probe',
        pid: LIMRUN_APP_PID,
        frame: { x: 161, y: 418.5, width: 80, height: 20.33 },
      },
      {
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'Request tracking',
        AXUniqueId: 'request-tracking',
        pid: LIMRUN_APP_PID,
        enabled: true,
        frame: { x: 136.67, y: 441, width: 129, height: 20.33 },
      },
      {
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'Present app alert',
        AXUniqueId: 'present-app-alert',
        pid: LIMRUN_APP_PID,
        enabled: true,
        frame: { x: 136, y: 463.33, width: 130.33, height: 20.33 },
      },
      {
        type: 'StaticText',
        role: 'AXStaticText',
        AXLabel: '21:15',
        pid: LIMRUN_SPRINGBOARD_PID,
        frame: { x: 53, y: 22.33, width: 42, height: 20.33 },
      },
      {
        type: 'GenericElement',
        role: 'AXGenericElement',
        AXLabel: 'Cellular',
        pid: LIMRUN_SPRINGBOARD_PID,
        frame: { x: 288.33, y: 26.33, width: 19.33, height: 12.33 },
      },
      {
        type: 'GenericElement',
        role: 'AXGenericElement',
        AXLabel: '100% battery power',
        pid: LIMRUN_SPRINGBOARD_PID,
        frame: { x: 339.33, y: 26, width: 27.33, height: 13 },
      },
    ],
  };
}

/**
 * Negative control: the live app-owned `UIAlertController` ("Unsaved changes" / Cancel /
 * Discard). It shares the flat text+button shape of a system alert but rides the app's root
 * with the app's pid, so the alert legs must refuse to treat it as one.
 */
export function limrunAppAlertDialogTree(): IosTreeNode {
  const home = limrunAppScreenTree();
  return {
    ...home,
    children: [
      {
        type: 'StaticText',
        role: 'AXStaticText',
        AXLabel: 'Unsaved changes',
        pid: LIMRUN_APP_PID,
        frame: { x: 82, y: 408.67, width: 238, height: 20.33 },
      },
      {
        type: 'StaticText',
        role: 'AXStaticText',
        AXLabel: 'Leave without saving?',
        pid: LIMRUN_APP_PID,
        frame: { x: 82, y: 432.67, width: 238, height: 15.67 },
      },
      {
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'Cancel',
        pid: LIMRUN_APP_PID,
        enabled: true,
        frame: { x: 66, y: 469.33, width: 135, height: 44 },
        traits: ['Button', 'Scrollable'],
      },
      {
        type: 'Button',
        role: 'AXButton',
        AXLabel: 'Discard',
        pid: LIMRUN_APP_PID,
        enabled: true,
        frame: { x: 201.33, y: 469.33, width: 134.67, height: 44 },
        traits: ['Button', 'Scrollable'],
      },
      ...(home.children ?? []).slice(3),
    ],
  };
}

/** SpringBoard's home screen: a blank-label root, but full of launch icons rather than a dialog. */
export function limrunHomeScreenTree(): IosTreeNode {
  return alertRoot([
    {
      type: 'Button',
      role: 'AXButton',
      AXLabel: 'Maps',
      pid: LIMRUN_SPRINGBOARD_PID,
      enabled: true,
      frame: { x: 24.33, y: 88, width: 168.33, height: 191 },
      traits: ['Scrollable', 'UpdatesFrequently', 'LaunchIcon'],
    },
    {
      type: 'Button',
      role: 'AXButton',
      AXLabel: 'Calendar',
      pid: LIMRUN_SPRINGBOARD_PID,
      enabled: true,
      frame: { x: 209.67, y: 88, width: 168.33, height: 191 },
      traits: ['Scrollable', 'UpdatesFrequently', 'LaunchIcon'],
    },
  ]);
}

/** A capture with no alert: the app screen with the ATT alert grafted on as a sibling root. */
export function limrunAlertOverlayOnAppScreenTree(): IosTreeNode[] {
  return [limrunAppScreenTree(), limrunAttAlertTree()];
}
