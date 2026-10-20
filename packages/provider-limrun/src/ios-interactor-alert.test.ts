import { describe, expect, it, vi } from 'vitest';
import { ALERT_BUTTON_UNDECIDED_REASON } from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import {
  limrunAlertTreeWithoutButtons,
  limrunAppAlertDialogTree,
  limrunAppScreenTree,
  limrunAttAlertTree,
} from './alert-detection.fixtures.ts';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';
import type { IosTreeNode } from './snapshot.ts';

// The legs load `./alert.ts` per call (ADR-0019 laziness inside the provider), and that module
// carries the shared tree-alert driver from `@agent-device/capture-kit/alert-tree-driver`. Warm
// it at collection, like `platform-android`'s own alert test does, so the first timed leg
// measures the legs, not the module graph's first transform.
await import('./alert.ts');

/**
 * The four legs as the interactor exposes them: observation is one `elementTree()` read per
 * probe, action is a `tap()` at the chosen button's center. Trees are the live Limrun captures.
 * These cases resolve on the first probe each; budget loops are pinned with driven clocks in
 * `alert.test.ts`, so nothing here waits production time.
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
    expect(result.status).toBe('visible');
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
    expect(result.status).toBe('none');
  });
});

describe('awaitAlert', () => {
  it('returns as soon as a capture shows the alert', async () => {
    // The fixture serves the same alert on every read, so the read count is the assertion that
    // proves this leg returns on the FIRST capture rather than polling past it.
    const { interactor, client } = sessionWithTrees([limrunAttAlertTree(), limrunAttAlertTree()]);

    const result = await interactor.awaitAlert!({ timeoutMs: 5_000 });

    expect(result.kind).toBe('alertWait');
    expect(result.alert).toMatchObject({ buttons: ['Ask App Not to Track', 'Allow'] });
    expect(client.elementTree).toHaveBeenCalledTimes(1);
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
    const { interactor, client } = sessionWithTrees([
      {
        ...limrunAlertTreeWithoutButtons(),
        children: [
          ...(limrunAlertTreeWithoutButtons().children ?? []),
          {
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'Maybe Later',
            pid: limrunAlertTreeWithoutButtons().pid,
            enabled: true,
            frame: { x: 57, y: 511.67, width: 288, height: 48 },
          },
          {
            type: 'Button',
            role: 'AXButton',
            AXLabel: 'More Info',
            pid: limrunAlertTreeWithoutButtons().pid,
            enabled: true,
            frame: { x: 57, y: 567.67, width: 288, height: 48 },
          },
        ],
      },
    ]);

    const error = await interactor.acceptAlert!().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AppError);
    const refusal = error as AppError;
    expect(refusal.code).toBe('COMMAND_FAILED');
    expect(refusal.details?.reason).toBe(ALERT_BUTTON_UNDECIDED_REASON);
    expect(refusal.details?.dispatched).toBe('no');
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
    // Exactly one tap, at the denying button: proving the affirmative one was never pressed.
    expect(client.tap).toHaveBeenCalledTimes(1);
    expect(client.tap).toHaveBeenCalledWith(201, 536);
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
});
