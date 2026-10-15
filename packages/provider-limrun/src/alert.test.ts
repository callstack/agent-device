import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  limrunAlertAmbiguousButtonsTree,
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
    return [next] as unknown as ReturnType<LimrunIosAlertClient['elementTree']>;
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

  it('refuses an ambiguous alert without tapping', async () => {
    const client = clientWithTrees([limrunAlertAmbiguousButtonsTree()]);

    await expect(handleLimrunIosAlert(client, 'accept', { sleep: async () => {} })).rejects.toThrow(
      'no button that clearly matches the action',
    );
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
