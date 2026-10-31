import { afterEach, expect, test, vi } from 'vitest';
import { createLimrunIosInteractor, type LimrunIosSession } from './ios.ts';
import type { AxeTreeNode } from '@agent-device/capture-kit/ios-axe-tree';

const FIELD_RECT = Object.freeze({ x: 24, y: 142, width: 354, height: 56 });

function emailField(editing: boolean): AxeTreeNode {
  return {
    type: 'TextField',
    AXLabel: 'Email',
    pid: 4242,
    frame: FIELD_RECT,
    traits: editing
      ? ['TextEntry', 'TextOperationsAvailable', 'IsEditing']
      : ['TextEntry', 'TextOperationsAvailable'],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function sessionWithTrees(trees: AxeTreeNode[]) {
  const calls: string[] = [];
  let reads = 0;
  const client = {
    elementTree: vi.fn(async () => {
      calls.push('elementTree');
      const tree = trees[Math.min(reads, trees.length - 1)];
      reads += 1;
      return tree;
    }),
    tap: vi.fn(async () => {
      calls.push('tap');
    }),
    pressKey: vi.fn(async (key: string, modifiers?: string[]) => {
      calls.push(`pressKey:${key}${modifiers?.length ? `+${modifiers.join('+')}` : ''}`);
    }),
    typeText: vi.fn(async () => {
      calls.push('typeText');
    }),
    setElementValue: vi.fn(async () => {
      calls.push('setElementValue');
    }),
  };
  const session = {
    platform: 'ios',
    instanceId: 'limrun-text-entry-instance',
    client,
  } as unknown as LimrunIosSession;
  return { interactor: createLimrunIosInteractor(session), client, calls };
}

test('type enters the focused field without the provider focus scan', async () => {
  const { interactor, client } = sessionWithTrees([]);

  await interactor.type('qa@example.com');

  expect(client.typeText).toHaveBeenCalledWith('qa@example.com', false, { requireFocus: false });
});

test('a delayed type sends one focused-blind key press per character', async () => {
  const { interactor, client } = sessionWithTrees([]);

  await interactor.type('abc', 1);

  expect(client.typeText.mock.calls).toEqual([
    ['a', false, { requireFocus: false }],
    ['b', false, { requireFocus: false }],
    ['c', false, { requireFocus: false }],
  ]);
});

test('fill waits for text-entry focus to arrive and only then sets the value', async () => {
  const { interactor, client, calls } = sessionWithTrees([
    emailField(false),
    emailField(false),
    emailField(true),
  ]);

  const result = await interactor.fill(200, 170, 'qa@example.com');

  expect(calls).toEqual(['elementTree', 'tap', 'elementTree', 'elementTree', 'setElementValue']);
  expect(result).toEqual({ textEntryReadiness: 'focused-element' });
  expect(client.setElementValue.mock.calls).toEqual([['qa@example.com']]);
  expect(client.pressKey).not.toHaveBeenCalled();
  expect(client.typeText).not.toHaveBeenCalled();
});

test.each([
  ['你好', undefined],
  ['qa@例子.com', undefined],
  ['👋', undefined],
  ['replacement', undefined],
  ['', undefined],
  ['你好a', 1],
  ['', 1],
])('fill writes %s once with delay %s', async (text, delayMs) => {
  const { interactor, client } = sessionWithTrees([emailField(false), emailField(true)]);

  const result = await interactor.fill(200, 170, text, delayMs);

  expect(result).toEqual({ textEntryReadiness: 'focused-element' });
  expect(client.setElementValue.mock.calls).toEqual([[text]]);
  expect(client.pressKey).not.toHaveBeenCalled();
  expect(client.typeText).not.toHaveBeenCalled();
});

test('a session that cannot answer the focus read fails before the device is touched', async () => {
  const { interactor, client, calls } = sessionWithTrees([emailField(false)]);
  client.elementTree.mockImplementationOnce(async () => {
    calls.push('elementTree');
    throw new Error('instance connection lost');
  });

  await expect(interactor.fill(200, 170, 'qa@example.com')).rejects.toThrow(
    'instance connection lost',
  );
  expect(calls).toEqual(['elementTree']);
  expect(client.tap).not.toHaveBeenCalled();
  expect(client.setElementValue).not.toHaveBeenCalled();
  expect(client.pressKey).not.toHaveBeenCalled();
  expect(client.typeText).not.toHaveBeenCalled();
});

test('fill writes no value when text-entry focus never arrives', async () => {
  const { interactor, client } = sessionWithTrees([emailField(false)]);
  // The focus budget is wall-clock time. Step the clock by that budget on every
  // read so the first miss expires it, and the refusal is not a three-second wait.
  let now = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => {
    const current = now;
    now += 3_000;
    return current;
  });

  await expect(interactor.fill(200, 170, '你好')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'text_entry_focus_not_observed' },
  });
  expect(client.tap).toHaveBeenCalledTimes(1);
  expect(client.setElementValue).not.toHaveBeenCalled();
  expect(client.pressKey).not.toHaveBeenCalled();
  expect(client.typeText).not.toHaveBeenCalled();
});

test('a rejected value write fails the fill with that failure', async () => {
  const { interactor, client } = sessionWithTrees([emailField(false), emailField(true)]);
  const failure = new Error('element value refused');
  client.setElementValue.mockRejectedValueOnce(failure);

  await expect(interactor.fill(200, 170, '你好')).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'text_entry_value_write_failed', dispatched: 'unknown' },
    cause: failure,
  });
  expect(client.setElementValue.mock.calls).toEqual([['你好']]);
  expect(client.pressKey).not.toHaveBeenCalled();
  expect(client.typeText).not.toHaveBeenCalled();
});
