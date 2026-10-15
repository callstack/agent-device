import { describe, expect, it } from 'vitest';
import {
  chooseLimrunAlertButton,
  findLimrunAlertCandidate,
  isLimrunAlertHostRoot,
} from './alert-detection.ts';
import {
  limrunAlertAmbiguousButtonsTree,
  limrunAlertOverlayOnAppScreenTree,
  limrunAlertTreeWithoutButtons,
  limrunAppAlertDialogTree,
  limrunAppScreenTree,
  limrunAttAlertTree,
  limrunHomeScreenTree,
} from './alert-detection.fixtures.ts';

function alertTreeWithButtons(...labels: string[]) {
  const root = limrunAttAlertTree();
  return {
    ...root,
    children: [
      ...(root.children ?? []).slice(0, 2),
      ...labels.map((label, index) => ({
        type: 'Button',
        role: 'AXButton',
        AXLabel: label,
        pid: root.pid,
        enabled: true,
        frame: { x: 57, y: 511.67 + index * 56, width: 288, height: 48 },
        traits: ['Button', 'Scrollable'],
      })),
    ],
  };
}

describe('isLimrunAlertHostRoot', () => {
  it('names the blank-label application root a system alert arrives on', () => {
    expect(isLimrunAlertHostRoot(limrunAttAlertTree())).toBe(true);
  });

  it('refuses an app-owned root: the app names its own application', () => {
    expect(isLimrunAlertHostRoot(limrunAppScreenTree())).toBe(false);
    expect(isLimrunAlertHostRoot(limrunAppAlertDialogTree())).toBe(false);
  });

  it('refuses roots that are not applications', () => {
    expect(isLimrunAlertHostRoot({ role: 'AXGroup', AXLabel: ' ' })).toBe(false);
    expect(isLimrunAlertHostRoot({ role: 'AXButton', AXLabel: ' ' })).toBe(false);
  });
});

describe('findLimrunAlertCandidate', () => {
  it('reads the live ATT alert: title, message, and both buttons in tree order', () => {
    const candidate = findLimrunAlertCandidate(limrunAttAlertTree());
    expect(candidate).not.toBeNull();
    expect(candidate?.alert.title).toBe(
      'Allow “ATTProbe” to track your activity across other companies’ apps and websites?',
    );
    expect(candidate?.alert.message).toBe(
      'This build asks for tracking authorization once, for automation testing.',
    );
    expect(candidate?.alert.buttons).toEqual(['Ask App Not to Track', 'Allow']);
    expect(candidate?.alert.platform).toBe('ios');
    expect(candidate?.alert.source).toBe('permission');
    expect(candidate?.buttons.map((button) => button.role)).toEqual(['dismiss', 'accept']);
    // The tap point is the live button frame's center, rounded the way `centerOfRect` rounds.
    expect(candidate?.buttons[1]).toEqual({ label: 'Allow', x: 201, y: 592, role: 'accept' });
  });

  it('finds the alert when the app screen is the first root of the capture', () => {
    const candidate = findLimrunAlertCandidate(limrunAlertOverlayOnAppScreenTree());
    expect(candidate?.alert.buttons).toEqual(['Ask App Not to Track', 'Allow']);
  });

  it('refuses the live app-owned UIAlertController: a named root is app UI, not a host sheet', () => {
    expect(findLimrunAlertCandidate(limrunAppAlertDialogTree())).toBeNull();
  });

  it('refuses a plain app screen', () => {
    expect(findLimrunAlertCandidate(limrunAppScreenTree())).toBeNull();
  });

  it("refuses SpringBoard's home screen: launch icons are not a dialog", () => {
    expect(findLimrunAlertCandidate(limrunHomeScreenTree())).toBeNull();
  });

  it('refuses a widget-bearing home screen: LaunchIcon buttons never qualify', () => {
    const home = limrunHomeScreenTree();
    const withWidgets = {
      ...home,
      children: [
        {
          type: 'StaticText',
          role: 'AXStaticText',
          AXLabel: 'Mostly Sunny',
          pid: home.pid,
          frame: { x: 24, y: 300, width: 160, height: 20 },
        },
        ...(home.children ?? []),
      ],
    };
    expect(findLimrunAlertCandidate(withWidgets)).toBeNull();
  });

  it('refuses an alert-shaped sheet with no actionable button', () => {
    expect(findLimrunAlertCandidate(limrunAlertTreeWithoutButtons())).toBeNull();
  });

  it('refuses a one-choice sheet: no action can tell its single option from the asked-for one', () => {
    expect(findLimrunAlertCandidate(alertTreeWithButtons('Allow'))).toBeNull();
    expect(findLimrunAlertCandidate(alertTreeWithButtons('OK'))).toBeNull();
  });

  it('refuses a capture whose host sheets disagree, rather than shadowing one with the other', () => {
    const second = { ...limrunAttAlertTree(), pid: 99 };
    expect(findLimrunAlertCandidate([limrunAttAlertTree(), second])).toBeNull();
  });

  it('reports a permission alert from its button vocabulary and a plain one as a system dialog', () => {
    expect(findLimrunAlertCandidate(limrunAttAlertTree())?.alert.source).toBe('permission');
    expect(findLimrunAlertCandidate(alertTreeWithButtons('No', 'Yes'))?.alert.source).toBe(
      'system-dialog',
    );
  });
});

describe('chooseLimrunAlertButton', () => {
  it('accepts the affirmative and dismisses the denying choice of the ATT prompt', () => {
    const buttons = findLimrunAlertCandidate(limrunAttAlertTree())!.buttons;
    expect(chooseLimrunAlertButton(buttons, 'accept')?.label).toBe('Allow');
    expect(chooseLimrunAlertButton(buttons, 'dismiss')?.label).toBe('Ask App Not to Track');
  });

  it('fails an ambiguous accept closed when no button classifies as affirmative', () => {
    const buttons = findLimrunAlertCandidate(limrunAlertAmbiguousButtonsTree())!.buttons;
    expect(chooseLimrunAlertButton(buttons, 'accept')).toBeNull();
  });

  it('fails an ambiguous dismiss closed when no button classifies as denying', () => {
    const buttons = findLimrunAlertCandidate(limrunAlertAmbiguousButtonsTree())!.buttons;
    expect(chooseLimrunAlertButton(buttons, 'dismiss')).toBeNull();
  });

  it('never picks a choice of the wrong role, whatever else the alert offers', () => {
    const allowOnly = findLimrunAlertCandidate(alertTreeWithButtons('Deny', 'Allow'))!.buttons;
    expect(chooseLimrunAlertButton(allowOnly, 'accept')?.label).toBe('Allow');
    expect(chooseLimrunAlertButton(allowOnly, 'dismiss')?.label).toBe('Deny');
    const noAccept = findLimrunAlertCandidate(
      alertTreeWithButtons('Cancel', 'Maybe Later'),
    )!.buttons;
    expect(chooseLimrunAlertButton(noAccept, 'accept')).toBeNull();
    const noDismiss = findLimrunAlertCandidate(
      alertTreeWithButtons('Open Settings', 'Continue'),
    )!.buttons;
    expect(chooseLimrunAlertButton(noDismiss, 'dismiss')).toBeNull();
  });

  it('classifies the classic iOS pair, the typographic apostrophe, and iOS variant grants', () => {
    const classic = findLimrunAlertCandidate(alertTreeWithButtons("Don't Allow", 'OK'))!.buttons;
    expect(chooseLimrunAlertButton(classic, 'accept')?.label).toBe('OK');
    expect(chooseLimrunAlertButton(classic, 'dismiss')?.label).toBe("Don't Allow");
    const curly = findLimrunAlertCandidate(alertTreeWithButtons('Don’t Allow', 'Allow'))!.buttons;
    expect(chooseLimrunAlertButton(curly, 'dismiss')?.label).toBe('Don’t Allow');
    const settings = findLimrunAlertCandidate(
      alertTreeWithButtons('Not Now', 'Open Settings'),
    )!.buttons;
    expect(chooseLimrunAlertButton(settings, 'accept')?.label).toBe('Open Settings');
    expect(chooseLimrunAlertButton(settings, 'dismiss')?.label).toBe('Not Now');
    for (const label of ['Allow Once', 'Allow All the Time', 'Allow While Using App']) {
      const granted = findLimrunAlertCandidate(
        alertTreeWithButtons('Ask App Not to Track', label),
      )!.buttons;
      expect(chooseLimrunAlertButton(granted, 'accept')?.label).toBe(label);
    }
  });

  it('refuses the candidate when no button is pressable', () => {
    const root = limrunAttAlertTree();
    const crippled = {
      ...root,
      children: [
        ...(root.children ?? []).slice(0, 2),
        {
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Allow',
          pid: root.pid,
          enabled: false,
          frame: { x: 57, y: 511.67, width: 288, height: 48 },
          traits: ['Button'],
        },
        {
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Ask App Not to Track',
          pid: root.pid,
          enabled: true,
          hittable: false,
          frame: { x: 57, y: 567.67, width: 288, height: 48 },
          traits: ['Button'],
        },
        {
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Later',
          pid: root.pid,
          enabled: true,
          traits: ['Button'],
        },
      ],
    };
    // Disabled, unhittable, and frameless buttons are all unpressable; with nothing pressable
    // left, the whole candidate is refused rather than half-served.
    expect(findLimrunAlertCandidate(crippled)).toBeNull();
  });
});
