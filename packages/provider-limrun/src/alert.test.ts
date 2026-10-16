import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_BUTTON_UNDECIDED_REASON,
  ALERT_CAPTURE_UNDECIDED_REASON,
} from '@agent-device/contracts/alert-contract';
import { AppError } from '@agent-device/kernel/errors';
import {
  limrunAlertAmbiguousButtonsTree,
  limrunAlertTreeWithUnpressableButtons,
  limrunAppScreenTree,
  limrunAttAlertTree,
  limrunLocationAlertTree,
} from './alert-detection.fixtures.ts';
import { handleLimrunIosAlert, type LimrunIosAlertClient } from './alert.ts';
import type { IosTreeNode } from './snapshot.ts';

/**
 * The legs share the tree-alert driver, whose polls sleep between captures on the shared
 * deadline primitive; the clock is the assertion, not the wait (`docs/agents/testing.md`).
 */
async function underFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const outcome = run();
    outcome.catch(() => {});
    await vi.runAllTimersAsync();
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

function clientWithTrees(trees: Array<IosTreeNode | IosTreeNode[]>): LimrunIosAlertClient {
  const elementTree = vi.fn(async () => {
    const next = trees.length > 1 ? trees.shift() : trees[0];
    // The real client answers an array for a multi-root capture and a single node otherwise.
    return (Array.isArray(next) ? next : [next]) as unknown as ReturnType<
      LimrunIosAlertClient['elementTree']
    >;
  });
  return { elementTree, tap: vi.fn(async () => {}) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('wait budget', () => {
  it('spends exactly the caller window and reports the timeout', async () => {
    const client = clientWithTrees([limrunAppScreenTree()]);

    await expect(
      underFakeTimers(() => handleLimrunIosAlert(client, 'wait', { timeoutMs: 5_000 })),
    ).rejects.toThrow('alert wait timed out');
    // One poll per interval over the whole window: never fewer (gave up early) nor real
    // seconds. The probe the sleep lands exactly on the deadline captures nothing — a closed
    // window answers for itself — so the count is the intervals, not intervals-plus-one.
    expect(client.elementTree).toHaveBeenCalledTimes(Math.ceil(5_000 / 300));
  });

  it('treats a malformed window as the bounded default rather than an unbound loop', async () => {
    const client = clientWithTrees([limrunAppScreenTree()]);

    await expect(
      underFakeTimers(() => handleLimrunIosAlert(client, 'wait', { timeoutMs: Number.NaN })),
    ).rejects.toThrow('alert wait timed out');
    // The fallback is the contract default, spent on the driven clock — this returned, so the
    // loop had a bound, which a NaN comparison would not have given it.
    expect(client.elementTree).toHaveBeenCalledTimes(Math.ceil(10_000 / 300));
  });

  it('reads a finite budget past the timer ceiling as the bounded default, never a misfire', async () => {
    // 2^32 reaches `AbortSignal.timeout` as a RangeError and 2^31 as a 1 ms timer; both must
    // arrive here as the contract default, spent on the driven clock.
    for (const oversized of [2 ** 31, 2 ** 32]) {
      const client = clientWithTrees([limrunAppScreenTree()]);
      await expect(
        underFakeTimers(() => handleLimrunIosAlert(client, 'wait', { timeoutMs: oversized })),
      ).rejects.toThrow('alert wait timed out');
      expect(client.elementTree).toHaveBeenCalledTimes(Math.ceil(10_000 / 300));
    }
  });

  it('never consumes a second capture that starts after the window closed', async () => {
    // The closing-probe bug: a poll the sleep lands past the deadline must not even capture —
    // its answer, alert or absence, is a late verdict the deadline already closed.
    const client = {
      elementTree: vi
        .fn()
        .mockResolvedValueOnce([limrunAppScreenTree()])
        // Were this answer ever consumed, `wait` would report the alert instead of timing out.
        .mockResolvedValueOnce([limrunAttAlertTree()]),
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    await expect(
      underFakeTimers(() => handleLimrunIosAlert(client, 'wait', { timeoutMs: 300 })),
    ).rejects.toThrow('alert wait timed out');
    expect(client.elementTree).toHaveBeenCalledTimes(1);
  });

  it('never presses on a candidate that resolves after the action window closed', async () => {
    // A bounded capture stalling past its 2s lookup budget lands after the deadline. Consuming
    // it would press an alert the window never resolved inside itself.
    const client = {
      elementTree: vi
        .fn()
        .mockResolvedValueOnce([limrunAppScreenTree()])
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([limrunAttAlertTree()]), 3_000);
            }),
        ),
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    const thrown = await underFakeTimers(() => handleLimrunIosAlert(client, 'accept')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(client.tap).not.toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(AppError);
    const failure = thrown as AppError;
    expect(failure.details?.reason).toBe('alert-window-expired');
    expect(failure.details?.dispatched).toBe('no');
  });

  it('surfaces a failed capture as itself, never as a timeout', async () => {
    const elementTree = vi
      .fn()
      .mockRejectedValue(
        new Error('websocket closed'),
      ) as unknown as LimrunIosAlertClient['elementTree'];
    const client = { elementTree, tap: vi.fn(async () => {}) } satisfies LimrunIosAlertClient;

    await expect(handleLimrunIosAlert(client, 'wait')).rejects.toThrow('websocket closed');
  });

  it('refuses a confirm capture that outruns its window without claiming a visible dialog', async () => {
    // The Limrun WebSocket client cannot abort an in-flight `elementTree`, so a stalled capture
    // can outlive the confirm budget. The driver must not consume that late answer — and because
    // no post-press capture ever answered, the failure may not accuse the dialog of still being
    // visible; it reports the press as unconfirmed.
    const client = {
      elementTree: vi
        .fn()
        .mockResolvedValueOnce([limrunAttAlertTree()]) // read-first probe resolves the alert
        // The confirm probe stalls 3s on the driven clock — past its 2s budget — and would
        // answer "gone" if its late result were trusted.
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([limrunAppScreenTree()]), 3_000);
            }),
        ),
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    const thrown = await underFakeTimers(() => handleLimrunIosAlert(client, 'accept')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(client.tap).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(AppError);
    const failure = thrown as AppError;
    expect(failure.message).toBe(
      'alert accept pressed the button but the dismissal could not be confirmed',
    );
    expect(failure.details?.reason).toBe('alert-window-expired');
  });
});

describe('get on an undecided capture', () => {
  it('says the capture cannot decide, rather than claiming no alert', async () => {
    const client = clientWithTrees([[limrunAttAlertTree(), limrunAttAlertTree()]]);

    const result = await handleLimrunIosAlert(client, 'get');

    expect(result.kind === 'alertStatus' && result.alert).toBeNull();
    // The states are typed on the result, not just in the message: `undecided` and `none`
    // arrive with the same null alert and must stay switchable apart.
    expect(result.kind === 'alertStatus' && result.status).toBe('undecided');
    expect(result.kind === 'alertStatus' && result.message).toBe(
      'Cannot decide the alert: the capture is alert-shaped but unresolvable',
    );
  });
});

describe('acting budgets', () => {
  it('spends the confirm budget and reports a stuck alert', async () => {
    const client = clientWithTrees([limrunAttAlertTree(), limrunAttAlertTree()]);

    const thrown = await underFakeTimers(() => handleLimrunIosAlert(client, 'dismiss')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AppError);
    const failure = thrown as AppError;
    expect(failure.message).toBe('alert dismiss did not dismiss the visible alert');
    // Every spent-budget exit of an acting leg branches on this reason, per commands.md.
    expect(failure.details?.reason).toBe('alert-window-expired');
    expect(client.tap).toHaveBeenCalledTimes(1);
  });

  it('reports an unconfirmed dismissal when an undecided re-read overrules the last match', async () => {
    // Confirm probe 1 re-names the pressed alert; probe 2 is alert-shaped yet unresolvable and
    // stays that way to the end of the budget. The undecided read is the fresher fact, so the
    // leg may not report the dialog as standing on the older match — it reports the press as
    // unconfirmed, which is all a spent budget with no settling read may say.
    const client = clientWithTrees([
      limrunAttAlertTree(),
      limrunAttAlertTree(),
      [limrunAttAlertTree(), limrunAttAlertTree()],
    ]);

    const thrown = await underFakeTimers(() => handleLimrunIosAlert(client, 'dismiss')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AppError);
    const failure = thrown as AppError;
    expect(failure.message).toBe(
      'alert dismiss pressed the button but the dismissal could not be confirmed',
    );
    expect(failure.details?.reason).toBe('alert-window-expired');
  });

  it('keeps the still-visible claim when a later capture hangs after one re-named the alert', async () => {
    // Same alert at confirm probe 1, then a stalled transport the budget cuts off. A hung probe
    // is not an observation: the still-visible failure rides the latest capture that answered,
    // which named the dialog, exactly as commands.md states. This is the executed provider
    // integration timeline (Coverage run 38924441176), where the f584 catch unconditionally
    // downgraded it to unconfirmed.
    const client = {
      elementTree: vi
        .fn()
        .mockResolvedValueOnce(limrunAttAlertTree())
        .mockResolvedValueOnce(limrunAttAlertTree())
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([limrunAppScreenTree()]), 3_000);
            }),
        ),
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    const thrown = await underFakeTimers(() => handleLimrunIosAlert(client, 'accept')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).message).toBe('alert accept did not dismiss the visible alert');
    expect((thrown as AppError).details?.reason).toBe('alert-window-expired');
    expect(client.tap).toHaveBeenCalledTimes(1);
  });

  it('refuses an ambiguous alert without tapping, on a typed reason', async () => {
    const client = clientWithTrees([limrunAlertAmbiguousButtonsTree()]);
    const thrown = await handleLimrunIosAlert(client, 'accept').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AppError);
    const refusal = thrown as AppError;
    expect(refusal.code).toBe('COMMAND_FAILED');
    expect(refusal.details?.reason).toBe(ALERT_BUTTON_UNDECIDED_REASON);
    expect(refusal.details?.dispatched).toBe('no');
    expect(client.tap).not.toHaveBeenCalled();
  });

  it('reports an unconfirmed dismissal when the post-tap capture stays unresolvable to the end', async () => {
    // The first probe resolves the single alert; every post-press probe carries two disagreeing
    // alert-shaped sheets. An unresolvable capture proves absence for nothing, so the confirm
    // loop keeps its budget and fails — and, having never named this alert on screen again, it
    // reports the press as unconfirmed rather than claiming a dialog it never re-observed.
    const client = clientWithTrees([
      limrunAttAlertTree(),
      [limrunAttAlertTree(), limrunAttAlertTree()],
    ]);

    await expect(underFakeTimers(() => handleLimrunIosAlert(client, 'dismiss'))).rejects.toThrow(
      'alert dismiss pressed the button but the dismissal could not be confirmed',
    );
  });

  it('reports an unconfirmed dismissal when the same root survives with degraded buttons', async () => {
    // The tap was ignored: the post-press capture is the same alert root with its choices dropped
    // to disabled, explicitly unhittable, and frameless — an unresolvable shape, not a re-named
    // alert. Degraded-but-present is not absence; the leg must fail, not report handled, and it
    // may not claim "still visible" beyond what the undecided capture proved.
    const client = clientWithTrees([limrunAttAlertTree(), limrunAlertTreeWithUnpressableButtons()]);

    await expect(underFakeTimers(() => handleLimrunIosAlert(client, 'accept'))).rejects.toThrow(
      'alert accept pressed the button but the dismissal could not be confirmed',
    );
    expect(client.tap).toHaveBeenCalledTimes(1);
  });

  it('confirms handled when the post-tap capture shows the app screen instead', async () => {
    // The closest genuine no-alert negative to the case above: the same seam and budgets, and
    // the app's own named root after the tap — observed absence, which does confirm.
    const client = clientWithTrees([limrunAttAlertTree(), limrunAppScreenTree()]);
    const result = await handleLimrunIosAlert(client, 'accept');
    expect(result.kind === 'alertHandled' && result.button).toBe('Allow');
  });

  it('taps exactly once on accept, and the next get reports no alert', async () => {
    // The maintainer's live-validated timeline at the unit seam: one tap for the action, the
    // post-tap confirm observes the app screen, and a following read sees that same absence.
    const client = clientWithTrees([limrunAttAlertTree(), limrunAppScreenTree()]);

    const handled = await handleLimrunIosAlert(client, 'accept');
    expect(handled.kind).toBe('alertHandled');
    expect(client.tap).toHaveBeenCalledTimes(1);

    const status = await handleLimrunIosAlert(client, 'get');
    expect(status.kind === 'alertStatus' && status.alert).toBeNull();
    expect(status.kind === 'alertStatus' && status.message).toBe('No alert visible');
  });

  it('accepts the three-button location sheet on the preferred grant, once', async () => {
    // The multi-grant regression at the action seam: "Allow Once" and "Allow While Using App"
    // both carry the accept role, and the shared preference table must land one tap on the
    // lasting grant rather than refusing the sheet.
    const client = clientWithTrees([limrunLocationAlertTree(), limrunAppScreenTree()]);

    const handled = await handleLimrunIosAlert(client, 'accept');
    expect(handled.kind).toBe('alertHandled');
    expect(handled.kind === 'alertHandled' && handled.button).toBe('Allow While Using App');
    expect(client.tap).toHaveBeenCalledTimes(1);
    // Grant center: x 57 + 288/2, y 623.67 + 48/2, rounded by the press seam to whole points.
    expect(client.tap).toHaveBeenCalledWith(201, 648);
  });

  it('refuses to act on an alert-shaped but unresolvable capture, without tapping', async () => {
    const client = clientWithTrees([limrunAlertTreeWithUnpressableButtons()]);

    const thrown = await underFakeTimers(() => handleLimrunIosAlert(client, 'accept')).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AppError);
    const refusal = thrown as AppError;
    expect(refusal.code).toBe('COMMAND_FAILED');
    expect(refusal.details?.reason).toBe(ALERT_CAPTURE_UNDECIDED_REASON);
    expect(refusal.details?.dispatched).toBe('no');
    expect(client.tap).not.toHaveBeenCalled();
  });
});

describe('button vocabulary', () => {
  function alertWith(left: string, right: string): IosTreeNode {
    const root = limrunAttAlertTree();
    return {
      ...root,
      children: [
        ...(root.children ?? []).slice(0, 2),
        ...[left, right].map((label, index) => ({
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

  it('accepts the iOS variant grants, not just the bare Allow', async () => {
    for (const label of ['Allow While Using App', 'Allow Once', 'Allow All the Time']) {
      const client = clientWithTrees([
        alertWith('Ask App Not to Track', label),
        limrunAppScreenTree(),
      ]);
      const result = await handleLimrunIosAlert(client, 'accept');
      expect(result.kind === 'alertHandled' && result.button).toBe(label);
    }
  });

  it('dismisses Close App, the ANRB denial', async () => {
    const client = clientWithTrees([alertWith('Close App', 'Wait'), limrunAppScreenTree()]);
    const result = await handleLimrunIosAlert(client, 'dismiss');
    expect(result.kind === 'alertHandled' && result.button).toBe('Close App');
  });
});
