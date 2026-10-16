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
} from './alert-detection.fixtures.ts';
import { handleLimrunIosAlert, type LimrunIosAlertClient } from './alert.ts';
import type { IosTreeNode } from './snapshot.ts';

// The clock is the assertion, not the wait (`docs/agents/testing.md`): only `Date` is faked, and
// the legs' sleep seam advances it, so budget loops terminate without real time.
const advanceClock = async (ms: number) => {
  vi.advanceTimersByTime(ms);
};

function fakeClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
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
  it('spends exactly the caller window through the sleep seam and reports the timeout', async () => {
    fakeClock();
    const client = clientWithTrees([limrunAppScreenTree()]);
    const sleep = vi.fn(advanceClock);

    const settled = handleLimrunIosAlert(client, 'wait', { timeoutMs: 5_000, sleep }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('alert wait timed out');
    // One poll per interval over the whole window: never fewer (gave up early) nor real seconds.
    expect(sleep).toHaveBeenCalledTimes(Math.ceil(5_000 / 300));
  });

  it('treats a malformed window as the bounded default rather than an unbound loop', async () => {
    fakeClock();
    const client = clientWithTrees([limrunAppScreenTree()]);
    const sleep = vi.fn(advanceClock);

    await expect(
      handleLimrunIosAlert(client, 'wait', { timeoutMs: Number.NaN, sleep }),
    ).rejects.toThrow('alert wait timed out');
    // The fallback is the contract default, spent on the driven clock — this returned, so the
    // loop had a bound, which a NaN comparison would not have given it.
    expect(sleep).toHaveBeenCalledTimes(Math.ceil(10_000 / 300));
  });

  it('surfaces a failed capture as itself, never as a timeout', async () => {
    const elementTree = vi
      .fn()
      .mockRejectedValue(
        new Error('websocket closed'),
      ) as unknown as LimrunIosAlertClient['elementTree'];
    const client = { elementTree, tap: vi.fn(async () => {}) } satisfies LimrunIosAlertClient;

    await expect(handleLimrunIosAlert(client, 'wait', { sleep: async () => {} })).rejects.toThrow(
      'websocket closed',
    );
  });
});

describe('get on an undecided capture', () => {
  it('says the capture cannot decide, rather than claiming no alert', async () => {
    const client = clientWithTrees([[limrunAttAlertTree(), limrunAttAlertTree()]]);

    const result = await handleLimrunIosAlert(client, 'get', { sleep: async () => {} });

    expect(result.kind === 'alertStatus' && result.alert).toBeNull();
    expect(result.kind === 'alertStatus' && result.message).toBe(
      'Cannot decide the alert: the capture is alert-shaped but unresolvable',
    );
  });
});

describe('acting budgets', () => {
  it('spends the confirm budget through the sleep seam and reports a stuck alert', async () => {
    fakeClock();
    const client = clientWithTrees([limrunAttAlertTree(), limrunAttAlertTree()]);
    const sleep = vi.fn(advanceClock);

    await expect(handleLimrunIosAlert(client, 'dismiss', { sleep })).rejects.toThrow(
      'alert dismiss did not dismiss the visible alert',
    );
    expect(client.tap).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalled();
  });

  it('refuses an ambiguous alert without tapping, on a typed reason', async () => {
    const client = clientWithTrees([limrunAlertAmbiguousButtonsTree()]);

    const error = await handleLimrunIosAlert(client, 'accept', {
      sleep: async () => {},
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    const refusal = error as AppError;
    expect(refusal.code).toBe('COMMAND_FAILED');
    expect(refusal.details?.reason).toBe(ALERT_BUTTON_UNDECIDED_REASON);
    expect(refusal.details?.dispatched).toBe('no');
    expect(client.tap).not.toHaveBeenCalled();
  });

  it('reports a stuck alert when the post-tap capture stays unresolvable to the end', async () => {
    fakeClock();
    // The first probe resolves the single alert; every post-tap probe carries two disagreeing
    // alert-shaped sheets. An unresolvable capture proves absence for nothing, so the confirm
    // loop keeps its budget and fails rather than reporting the alert handled.
    const client = clientWithTrees([
      limrunAttAlertTree(),
      [limrunAttAlertTree(), limrunAttAlertTree()],
    ]);
    const sleep = vi.fn(advanceClock);

    await expect(handleLimrunIosAlert(client, 'dismiss', { sleep })).rejects.toThrow(
      'alert dismiss did not dismiss the visible alert',
    );
  });

  it('reports a stuck alert when the same root survives the tap with degraded buttons', async () => {
    fakeClock();
    // The tap was ignored: the post-tap capture is the same alert root with its choices dropped
    // to disabled, explicitly unhittable, and frameless. Degraded-but-present is not absence;
    // the leg must fail, not report handled.
    const client = clientWithTrees([limrunAttAlertTree(), limrunAlertTreeWithUnpressableButtons()]);
    const sleep = vi.fn(advanceClock);

    await expect(handleLimrunIosAlert(client, 'accept', { sleep })).rejects.toThrow(
      'alert accept did not dismiss the visible alert',
    );
    expect(client.tap).toHaveBeenCalledTimes(1);
  });

  it('confirms handled when the post-tap capture shows the app screen instead', async () => {
    // The closest genuine no-alert negative to the case above: the same seam and budgets, and
    // the app's own named root after the tap — observed absence, which does confirm.
    const client = clientWithTrees([limrunAttAlertTree(), limrunAppScreenTree()]);
    const result = await handleLimrunIosAlert(client, 'accept', { sleep: async () => {} });
    expect(result.kind === 'alertHandled' && result.button).toBe('Allow');
  });

  it('refuses to act on an alert-shaped but unresolvable capture, without tapping', async () => {
    fakeClock();
    const client = clientWithTrees([limrunAlertTreeWithUnpressableButtons()]);
    const sleep = vi.fn(advanceClock);

    const error = await handleLimrunIosAlert(client, 'accept', { sleep }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    const refusal = error as AppError;
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
      const result = await handleLimrunIosAlert(client, 'accept', { sleep: async () => {} });
      expect(result.kind === 'alertHandled' && result.button).toBe(label);
    }
  });

  it('dismisses Close App, the ANRB denial', async () => {
    const client = clientWithTrees([alertWith('Close App', 'Wait'), limrunAppScreenTree()]);
    const result = await handleLimrunIosAlert(client, 'dismiss', { sleep: async () => {} });
    expect(result.kind === 'alertHandled' && result.button).toBe('Close App');
  });
});
