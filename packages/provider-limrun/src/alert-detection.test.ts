import { describe, expect, it } from 'vitest';
import {
  chooseLimrunAlertButton,
  isLimrunAlertHostRoot,
  readLimrunAlertCapture,
} from './alert-detection.ts';
import {
  limrunAlertAmbiguousButtonsTree,
  limrunAlertOverlayOnAppScreenTree,
  limrunAlertTreeWithUnpressableButtons,
  limrunAlertTreeWithoutButtons,
  limrunAppAlertDialogTree,
  limrunAppScreenTree,
  limrunAttAlertTree,
  limrunBlankRootAppDialogLookalikeTree,
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

describe('readLimrunAlertCapture', () => {
  it('reads the live ATT alert: title, message, and both buttons in tree order', () => {
    const capture = readLimrunAlertCapture(limrunAttAlertTree());
    expect(capture.kind).toBe('alert');
    if (capture.kind !== 'alert') return;
    expect(capture.candidate.alert.title).toBe(
      'Allow “ATTProbe” to track your activity across other companies’ apps and websites?',
    );
    expect(capture.candidate.alert.message).toBe(
      'This build asks for tracking authorization once, for automation testing.',
    );
    expect(capture.candidate.alert.buttons).toEqual(['Ask App Not to Track', 'Allow']);
    expect(capture.candidate.alert.platform).toBe('ios');
    expect(capture.candidate.alert.source).toBe('permission');
    expect(capture.candidate.buttons.map((button) => button.role)).toEqual(['dismiss', 'accept']);
    // The tap point is the live button frame's center, rounded the way `centerOfRect` rounds.
    expect(capture.candidate.buttons[1]).toEqual({
      label: 'Allow',
      x: 201,
      y: 592,
      role: 'accept',
    });
  });

  it('finds the alert when the app screen is the first root of the capture', () => {
    const capture = readLimrunAlertCapture(limrunAlertOverlayOnAppScreenTree());
    expect(capture.kind === 'alert' && capture.candidate.alert.buttons).toEqual([
      'Ask App Not to Track',
      'Allow',
    ]);
  });

  it('refuses the live app-owned UIAlertController: a named root is app UI, not a host sheet', () => {
    expect(readLimrunAlertCapture(limrunAppAlertDialogTree()).kind).toBe('none');
  });

  it('refuses a plain app screen', () => {
    expect(readLimrunAlertCapture(limrunAppScreenTree()).kind).toBe('none');
  });

  it("refuses SpringBoard's home screen: launch icons are not a dialog", () => {
    expect(readLimrunAlertCapture(limrunHomeScreenTree()).kind).toBe('none');
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
    expect(readLimrunAlertCapture(withWidgets).kind).toBe('none');
  });

  it('reports a text-only sheet on a blank root as undecided, not absence', () => {
    // Buttons can drop out between captures mid-transition; a message on a host-shaped root
    // is alert-shaped content the reader cannot resolve, and absence is a stronger claim.
    expect(readLimrunAlertCapture(limrunAlertTreeWithoutButtons()).kind).toBe('undecided');
  });

  it('reports a one-choice sheet as undecided: alert-shaped, not resolvable to an action', () => {
    expect(readLimrunAlertCapture(alertTreeWithButtons('Allow')).kind).toBe('undecided');
    expect(readLimrunAlertCapture(alertTreeWithButtons('OK')).kind).toBe('undecided');
  });

  it('reports a capture mixing an app screen and a text-only sheet as undecided', () => {
    expect(
      readLimrunAlertCapture([limrunAppScreenTree(), limrunAlertTreeWithoutButtons()]).kind,
    ).toBe('undecided');
  });

  it('reports a capture whose host sheets disagree as undecided, not as no alert', () => {
    const second = {
      ...limrunAttAlertTree(),
      pid: 99,
      children: (limrunAttAlertTree().children ?? []).map((child) => ({ ...child, pid: 99 })),
    };
    expect(readLimrunAlertCapture([limrunAttAlertTree(), second]).kind).toBe('undecided');
  });

  it('reports a blank-label root that reports no pid as undecided: unverifiable, not absent', () => {
    const root = limrunAttAlertTree();
    expect(readLimrunAlertCapture({ ...root, pid: undefined }).kind).toBe('undecided');
  });

  it('reports a blank-label root whose content belongs to another process as undecided', () => {
    const root = limrunAttAlertTree();
    const foreignContent = {
      ...root,
      children: (root.children ?? []).map((child) => ({ ...child, pid: 4242 })),
    };
    expect(readLimrunAlertCapture(foreignContent).kind).toBe('undecided');
  });

  it('reports the blank-root app-dialog lookalike as undecided, never an actionable alert', () => {
    // The live app captures ride SpringBoard status nodes (a foreign pid) on the app root; the
    // system alert root is process-exclusive. Blanking the app dialog's label keeps that
    // discriminator intact: the capture is alert-shaped yet never resolves to a candidate some
    // action could press into.
    expect(readLimrunAlertCapture(limrunBlankRootAppDialogLookalikeTree()).kind).toBe('undecided');
  });

  it('reports a blank-label sheet sharing its root with another process as undecided', () => {
    const root = limrunAttAlertTree();
    const shared = {
      ...root,
      children: [
        ...(root.children ?? []),
        {
          type: 'GenericElement',
          role: 'AXGenericElement',
          AXLabel: 'Cellular',
          pid: 4242,
          frame: { x: 288, y: 26, width: 19, height: 12 },
        },
      ],
    };
    expect(readLimrunAlertCapture(shared).kind).toBe('undecided');
  });

  it('reports a sheet whose every button is unpressable as undecided, not absence', () => {
    // Disabled, explicitly unhittable, and frameless buttons press nothing; the dialog they
    // belong to is still visibly up, so the capture must not claim absence.
    expect(readLimrunAlertCapture(limrunAlertTreeWithUnpressableButtons()).kind).toBe('undecided');
  });

  it('reports a permission alert from its button vocabulary and a plain one as a system dialog', () => {
    const att = readLimrunAlertCapture(limrunAttAlertTree());
    expect(att.kind === 'alert' && att.candidate.alert.source).toBe('permission');
    const plain = readLimrunAlertCapture(alertTreeWithButtons('No', 'Yes'));
    expect(plain.kind === 'alert' && plain.candidate.alert.source).toBe('system-dialog');
  });
});

describe('chooseLimrunAlertButton', () => {
  function buttonsOf(tree: Parameters<typeof readLimrunAlertCapture>[0]) {
    const capture = readLimrunAlertCapture(tree);
    if (capture.kind !== 'alert') throw new Error('expected an alert capture');
    return capture.candidate.buttons;
  }

  it('accepts the affirmative and dismisses the denying choice of the ATT prompt', () => {
    const buttons = buttonsOf(limrunAttAlertTree());
    expect(chooseLimrunAlertButton(buttons, 'accept')?.label).toBe('Allow');
    expect(chooseLimrunAlertButton(buttons, 'dismiss')?.label).toBe('Ask App Not to Track');
  });

  it('fails an ambiguous accept closed when no button classifies as affirmative', () => {
    const buttons = buttonsOf(limrunAlertAmbiguousButtonsTree());
    expect(chooseLimrunAlertButton(buttons, 'accept')).toBeNull();
  });

  it('fails an ambiguous dismiss closed when no button classifies as denying', () => {
    const buttons = buttonsOf(limrunAlertAmbiguousButtonsTree());
    expect(chooseLimrunAlertButton(buttons, 'dismiss')).toBeNull();
  });

  it('never picks a choice of the wrong role, whatever else the alert offers', () => {
    const allowOnly = buttonsOf(alertTreeWithButtons('Deny', 'Allow'));
    expect(chooseLimrunAlertButton(allowOnly, 'accept')?.label).toBe('Allow');
    expect(chooseLimrunAlertButton(allowOnly, 'dismiss')?.label).toBe('Deny');
    const noAccept = buttonsOf(alertTreeWithButtons('Cancel', 'Maybe Later'));
    expect(chooseLimrunAlertButton(noAccept, 'accept')).toBeNull();
    const noDismiss = buttonsOf(alertTreeWithButtons('Open Settings', 'Continue'));
    expect(chooseLimrunAlertButton(noDismiss, 'dismiss')).toBeNull();
  });

  it('classifies the classic iOS pair, the typographic apostrophe, and iOS variant grants', () => {
    const classic = buttonsOf(alertTreeWithButtons("Don't Allow", 'OK'));
    expect(chooseLimrunAlertButton(classic, 'accept')?.label).toBe('OK');
    expect(chooseLimrunAlertButton(classic, 'dismiss')?.label).toBe("Don't Allow");
    const curly = buttonsOf(alertTreeWithButtons('Don’t Allow', 'Allow'));
    expect(chooseLimrunAlertButton(curly, 'dismiss')?.label).toBe('Don’t Allow');
    const settings = buttonsOf(alertTreeWithButtons('Not Now', 'Open Settings'));
    expect(chooseLimrunAlertButton(settings, 'accept')?.label).toBe('Open Settings');
    expect(chooseLimrunAlertButton(settings, 'dismiss')?.label).toBe('Not Now');
    for (const label of ['Allow Once', 'Allow All the Time', 'Allow While Using App']) {
      const granted = buttonsOf(alertTreeWithButtons('Ask App Not to Track', label));
      expect(chooseLimrunAlertButton(granted, 'accept')?.label).toBe(label);
    }
  });

  it('refuses a choice two physical buttons share: pressing one of them would guess', () => {
    const doubled = buttonsOf(alertTreeWithButtons('Allow', 'Deny', 'Allow'));
    expect(chooseLimrunAlertButton(doubled, 'accept')).toBeNull();
    expect(chooseLimrunAlertButton(doubled, 'dismiss')?.label).toBe('Deny');
  });
});
