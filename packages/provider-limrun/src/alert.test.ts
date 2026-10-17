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
    // One poll per interval over the window, plus the final sample the polling primitive
    // lands exactly on the deadline: a probe that starts at the boundary is a started probe,
    // and the budget rule lets it answer — the deadline ends the loop, it does not unstart it.
    expect(client.elementTree).toHaveBeenCalledTimes(Math.ceil(5_000 / 300) + 1);
  });

  it('treats a malformed window as the bounded default rather than an unbound loop', async () => {
    const client = clientWithTrees([limrunAppScreenTree()]);

    await expect(
      underFakeTimers(() => handleLimrunIosAlert(client, 'wait', { timeoutMs: Number.NaN })),
    ).rejects.toThrow('alert wait timed out');
    // The fallback is the contract default, spent on the driven clock — this returned, so the
    // loop had a bound, which a NaN comparison would not have given it.
    expect(client.elementTree).toHaveBeenCalledTimes(Math.ceil(10_000 / 300) + 1);
  });

  it('reads a finite budget past the timer ceiling as the bounded default, never a misfire', async () => {
    // 2^32 reaches `AbortSignal.timeout` as a RangeError and 2^31 as a 1 ms timer; both must
    // arrive here as the contract default, spent on the driven clock.
    for (const oversized of [2 ** 31, 2 ** 32]) {
      const client = clientWithTrees([limrunAppScreenTree()]);
      await expect(
        underFakeTimers(() => handleLimrunIosAlert(client, 'wait', { timeoutMs: oversized })),
      ).rejects.toThrow('alert wait timed out');
      expect(client.elementTree).toHaveBeenCalledTimes(Math.ceil(10_000 / 300) + 1);
    }
  });

  it('consumes the boundary sample: an alert answering exactly at the deadline is still reported', async () => {
    // The budget rule applied to `wait`: the poll that the sleep lands on the deadline is a
    // started probe — it finishes and its answer counts. The old contract refused it as a late
    // verdict; under the new one a sheet visible as the budget closes is exactly what `wait`
    // is for. No probe ever starts once the budget has passed: the boundary sample is the last.
    const client = {
      elementTree: vi
        .fn()
        .mockResolvedValueOnce([limrunAppScreenTree()])
        .mockResolvedValueOnce([limrunAttAlertTree()]),
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    const result = await underFakeTimers(() =>
      handleLimrunIosAlert(client, 'wait', { timeoutMs: 300 }),
    );
    expect(result.kind).toBe('alertWait');
    expect(client.elementTree).toHaveBeenCalledTimes(2);
  });

  it('presses a candidate whose started lookup probe answered after the deadline', async () => {
    // The maintainer's whole-rule pin on the acting leg: a bounded lookup probe stalling past
    // its 2s budget still finishes, and the alert it names is the alert on screen — the press
    // acts on it rather than refusing. The old code threw `alert-window-expired, dispatched:
    // no` here even though the sheet was plainly visible to the probe it had started.
    const client = {
      elementTree: vi
        .fn()
        .mockResolvedValueOnce([limrunAppScreenTree()])
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([limrunAttAlertTree()]), 3_000);
            }),
        )
        // The post-press confirm read sees the app screen: the press did land.
        .mockResolvedValue([limrunAppScreenTree()]),
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    const handled = await underFakeTimers(() => handleLimrunIosAlert(client, 'accept'));
    expect(handled.kind).toBe('alertHandled');
    expect(client.tap).toHaveBeenCalledTimes(1);
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

  it('ends the leg on cancellation only when the capture transport dies with it', async () => {
    // The accepted capability limit, tested rather than assumed. The Limrun client exposes no
    // abort on `elementTree`, so a caller cancel cannot unstart or cut a capture already in
    // flight: awaiting it keeps the leg open (the caller's own request ends at the daemon; this
    // promise is detached work no seam may fake-abort). What does end the leg is the transport
    // route the SDK does have — an instance teardown that fails the pending call — and the
    // driver reports that as the shared cancellation, never as a broken backend.
    const caller = new AbortController();
    let settled = 'pending';
    let rejectCapture: ((error: unknown) => void) | undefined;
    let markCaptureStarted!: () => void;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    const client = {
      elementTree: vi.fn(() => {
        markCaptureStarted();
        return new Promise((_resolve, reject) => {
          rejectCapture = reject;
        });
      }) as unknown as LimrunIosAlertClient['elementTree'],
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;
    const leg = handleLimrunIosAlert(client, 'get', { signal: caller.signal });
    leg.then(
      () => {
        settled = 'resolved';
      },
      () => {
        settled = 'rejected';
      },
    );
    await captureStarted;
    // Canceled, and the in-flight capture with no abort still holds the leg open.
    caller.abort();
    await Promise.resolve();
    expect(settled).toBe('pending');

    // The instance/session teardown route: the pending call fails, the leg ends, and it ends as
    // the caller's cancellation — not as a transport failure. It is a pre-press exit (acting
    // legs never press before their lookup returns; get has no press), so it carries the clean
    // dispatched: no like the other pre-press refusal.
    rejectCapture?.(new Error('websocket closed'));
    await expect(leg).rejects.toMatchObject({
      details: { reason: 'request_canceled', dispatched: 'no' },
    });
  });

  it('reports a press-cancelled acting leg as dispatched: unknown even when the tap answers after the cancel', async () => {
    // The tap transport has no abort either: the cancel can arrive while `tap()` is pending and
    // the promise simply RESOLVE anyway. A resolved press after a cancel still says "the device
    // may have the tap" — the leg must answer `dispatched: unknown`, never a confirmation or a
    // clean cancellation.
    let resolveTap: (() => void) | undefined;
    let markTapStarted!: () => void;
    const tapStarted = new Promise<void>((resolve) => {
      markTapStarted = resolve;
    });
    const trees: Array<ReturnType<typeof limrunAttAlertTree>> = [limrunAttAlertTree()];
    const client = {
      elementTree: vi.fn(async () => {
        // Lookup resolves the alert; a confirm read would see it gone — the cancel must end
        // the leg before that read is ever started.
        const next =
          trees.length > 0 ? (trees.shift() ?? limrunAppScreenTree()) : limrunAppScreenTree();
        return [next] as unknown as ReturnType<LimrunIosAlertClient['elementTree']>;
      }),
      tap: vi.fn(() => {
        markTapStarted();
        return new Promise<void>((resolve) => {
          resolveTap = resolve;
        });
      }),
    } satisfies LimrunIosAlertClient;

    const caller = new AbortController();
    const leg = handleLimrunIosAlert(client, 'accept', { signal: caller.signal });
    leg.catch(() => {});
    await tapStarted;
    caller.abort();
    resolveTap?.();

    await expect(leg).rejects.toMatchObject({
      details: { reason: 'request_canceled', dispatched: 'unknown' },
    });
    // Exactly one dispatch attempt, never a replay: the leg died with the cancel, not with a
    // second press or a confirm that contradicts what the caller already withdrew.
    expect(client.tap).toHaveBeenCalledTimes(1);
    // And the closest witness that the leg ended BEFORE any confirm read: the only capture is
    // the lookup probe that resolved the alert — the confirm loop's top-of-loop cancellation
    // check stops it before it starts a probe.
    expect(client.elementTree).toHaveBeenCalledTimes(1);
  });

  it('honors a cancel that arrives while a straddling lookup probe is in flight: no press starts', async () => {
    // The probe the cancel rode finished anyway (the budget rule) — but its alert answer is NOT
    // acted on once the caller withdrew the action: the leg refuses at the pre-press boundary
    // with the clean cancellation and dispatched: no, and no tap is ever attempted.
    let resolveCapture: ((value: unknown) => void) | undefined;
    let markCaptureStarted!: () => void;
    const captureStarted = new Promise<void>((resolve) => {
      markCaptureStarted = resolve;
    });
    const held = {
      elementTree: vi.fn(() => {
        markCaptureStarted();
        return new Promise((resolve) => {
          resolveCapture = resolve;
        });
      }) as unknown as LimrunIosAlertClient['elementTree'],
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    const caller = new AbortController();
    const leg = handleLimrunIosAlert(held, 'accept', { signal: caller.signal });
    leg.catch(() => {});
    await captureStarted;
    caller.abort();
    resolveCapture?.([limrunAttAlertTree()]);

    await expect(leg).rejects.toMatchObject({
      details: { reason: 'request_canceled', dispatched: 'no' },
    });
    expect(held.tap).toHaveBeenCalledTimes(0);
  });

  it('consumes a confirm capture that answers past its window deadline', async () => {
    // The same rule after the press: the first confirm probe started inside the confirm budget,
    // so it finishes and its answer decides. The Limrun WebSocket client cannot abort an
    // in-flight `elementTree` — under the old contract the leg refused the late answer and
    // reported the press unconfirmed; under the budget rule the capture that saw the app screen
    // IS the confirmation, and the leg handled. The cost is the documented one-call overrun:
    // the leg waits for the started transport instead of answering at 2 s.
    const client = {
      elementTree: vi
        .fn()
        .mockResolvedValueOnce([limrunAttAlertTree()]) // lookup probe resolves the alert
        // The confirm probe stalls 3s on the driven clock — past its 2s budget — and answers
        // "gone": under the rule, that answer counts.
        .mockImplementationOnce(
          async () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([limrunAppScreenTree()]), 3_000);
            }),
        ),
      tap: vi.fn(async () => {}),
    } satisfies LimrunIosAlertClient;

    const handled = await underFakeTimers(() => handleLimrunIosAlert(client, 'accept'));
    expect(client.tap).toHaveBeenCalledTimes(1);
    expect(handled.kind).toBe('alertHandled');
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

  it('confirms on the capture that answers after a straddle, even one that first re-named the alert', async () => {
    // Budget rule over the older sighting rule: confirm probe 1 re-named the pressed alert,
    // probe 2 started inside the budget and answers past its deadline that the screen is now
    // the app. Both are started-probe answers, so both count, and the freshest one settles the
    // dismissal — the dialog the latest capture that answered saw is gone. The old code kept
    // the earlier sighting as a still-visible failure precisely because this straddling capture
    // was refused; the maintainer's whole-rule supersedes that.
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

    const handled = await underFakeTimers(() => handleLimrunIosAlert(client, 'accept'));
    expect(handled.kind).toBe('alertHandled');
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
