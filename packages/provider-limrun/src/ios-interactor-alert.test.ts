import { describe, expect, it, vi } from 'vitest';
import {
  limrunAlertTreeWithoutButtons,
  limrunAppAlertDialogTree,
  limrunAppScreenTree,
  limrunAttAlertTree,
} from './alert-detection.fixtures.ts';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';
import type { IosTreeNode } from './snapshot.ts';

/**
 * The four legs as the interactor exposes them: observation is one `elementTree()` read per
 * probe, action is a `tap()` at the chosen button's center. Trees are the live Limrun captures.
 */
function sessionWithTrees(trees: Array<IosTreeNode | IosTreeNode[]>) {
  const elementTree = vi.fn(async () => {
    const next = trees.length > 1 ? trees.shift() : trees[0];
    return [next];
  });
  const client = { elementTree, tap: vi.fn(async () => {}) };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-alert-instance',
    client,
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client };
}

describe('readAlert', () => {
  it('reports the live ATT alert with its buttons', async () => {
    const { interactor } = sessionWithTrees([limrunAttAlertTree()]);

    const result = await interactor.readAlert!();

    expect(result.kind).toBe('alertStatus');
    expect(result.alert).toMatchObject({
      platform: 'ios',
      source: 'permission',
      buttons: ['Ask App Not to Track', 'Allow'],
    });
  });

  it('reports no alert for the live app-owned dialog rather than claiming it', async () => {
    const { interactor } = sessionWithTrees([limrunAppAlertDialogTree()]);

    const result = await interactor.readAlert!();

    expect(result.kind).toBe('alertStatus');
    expect(result.alert).toBeNull();
  });
});

describe('awaitAlert', () => {
  it('returns as soon as a capture shows the alert', async () => {
    const { interactor } = sessionWithTrees([limrunAppScreenTree(), limrunAttAlertTree()]);

    const result = await interactor.awaitAlert!({ timeoutMs: 5_000 });

    expect(result.kind).toBe('alertWait');
    expect(result.alert).toMatchObject({ buttons: ['Ask App Not to Track', 'Allow'] });
  });

  it('times out while no capture ever shows an alert', async () => {
    const { interactor } = sessionWithTrees([limrunAppScreenTree()]);

    await expect(interactor.awaitAlert!({ timeoutMs: 1 })).rejects.toThrow('alert wait timed out');
  });
});

describe('acceptAlert', () => {
  it('taps the affirmative choice and reports it, then re-reads to confirm', async () => {
    const { interactor, client } = sessionWithTrees([
      limrunAttAlertTree(),
      limrunAppScreenTree(),
      limrunAppScreenTree(),
    ]);

    const result = await interactor.acceptAlert!();

    expect(result).toMatchObject({
      kind: 'alertHandled',
      action: 'accept',
      handled: true,
      button: 'Allow',
      // `centerOfRect` rounds: the live Allow frame centers at (201, 592).
      coordinates: { x: 201, y: 592 },
    });
    expect(client.tap).toHaveBeenCalledTimes(1);
    expect(client.tap).toHaveBeenCalledWith(201, 592);
  });

  it('refuses an alert whose buttons name no affirmative choice and taps nothing', async () => {
    const root = limrunAttAlertTree();
    const ambiguous = {
      ...root,
      children: [
        ...(root.children ?? []).slice(0, 2),
        {
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'Maybe Later',
          pid: root.pid,
          enabled: true,
          frame: { x: 57, y: 511.67, width: 288, height: 48 },
        },
        {
          type: 'Button',
          role: 'AXButton',
          AXLabel: 'More Info',
          pid: root.pid,
          enabled: true,
          frame: { x: 57, y: 567.67, width: 288, height: 48 },
        },
      ],
    };
    const { interactor, client } = sessionWithTrees([ambiguous]);

    await expect(interactor.acceptAlert!()).rejects.toThrow(
      'alert accept found an alert but no button that clearly matches the action',
    );
    expect(client.tap).not.toHaveBeenCalled();
  });

  it('refuses an app-owned dialog as no alert and taps nothing', async () => {
    const { interactor, client } = sessionWithTrees([limrunAppAlertDialogTree()]);

    await expect(interactor.acceptAlert!()).rejects.toThrow('alert not found');
    expect(client.tap).not.toHaveBeenCalled();
  });
});

describe('dismissAlert', () => {
  it('taps the denying choice, never the affirmative one', async () => {
    const { interactor, client } = sessionWithTrees([
      limrunAttAlertTree(),
      limrunAppScreenTree(),
      limrunAppScreenTree(),
    ]);

    const result = await interactor.dismissAlert!();

    expect(result).toMatchObject({
      kind: 'alertHandled',
      action: 'dismiss',
      button: 'Ask App Not to Track',
    });
    expect(client.tap).toHaveBeenCalledWith(201, 536);
  });

  it('reports a press that left the same alert visible', async () => {
    const stuck = [limrunAttAlertTree(), limrunAttAlertTree()];
    const { interactor } = sessionWithTrees(stuck);

    await expect(interactor.dismissAlert!()).rejects.toThrow(
      'alert dismiss did not dismiss the visible alert',
    );
  });

  it('accepts a replacement alert as a dismissal of the first', async () => {
    const replacement = {
      ...limrunAttAlertTree(),
      children: (limrunAttAlertTree().children ?? []).map((child, index) =>
        index >= 2 ? { ...child, AXLabel: index === 2 ? 'No' : 'Yes' } : child,
      ),
    };
    const { interactor } = sessionWithTrees([limrunAttAlertTree(), replacement, replacement]);

    await expect(interactor.dismissAlert!()).resolves.toMatchObject({
      kind: 'alertHandled',
      button: 'Ask App Not to Track',
    });
  });

  it('refuses an alert-shaped sheet with no pressable button as no alert', async () => {
    const { interactor, client } = sessionWithTrees([limrunAlertTreeWithoutButtons()]);

    await expect(interactor.dismissAlert!()).rejects.toThrow('alert not found');
    expect(client.tap).not.toHaveBeenCalled();
  });
});
